import type { Attachment, MessageState, ReplyEntry } from '@meza/core';
import {
  ackMessage,
  addReaction,
  backfillChannel,
  buildMessageContent,
  decryptAndUpdateMessages,
  editMessage,
  encryptMessage,
  fetchAndCacheChannelKeys,
  formatRelativeTime,
  getMessages,
  getMessagesByIDs,
  getPublicKeys,
  getReactions,
  getReplies,
  hasChannelKey,
  hasPermission,
  isSessionReady,
  listEmojis,
  listMembers,
  listRoles,
  listUserEmojis,
  Permissions,
  pinMessage,
  safeParseMessageText,
  toISO,
  unpinMessage,
  useAuthStore,
  useEmojiStore,
  useGatewayStore,
  useMemberStore,
  useMessageStore,
  usePinStore,
  useReactionStore,
  useReadStateStore,
  useRoleStore,
  useServerStore,
  useUsersStore,
} from '@meza/core';
import { LockKeyIcon, PushPinIcon, SmileyIcon } from '@phosphor-icons/react';

import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import {
  Fragment,
  type KeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useChannelEncryption } from '../../hooks/useChannelEncryption.ts';
import { useDisplayColor } from '../../hooks/useDisplayColor.ts';
import { useDisplayName } from '../../hooks/useDisplayName.ts';
import { openProfilePane } from '../../stores/tiling.ts';
import { ProfilePopoverCard } from '../profile/ProfilePopoverCard.tsx';
import { Avatar } from '../shared/Avatar.tsx';
import { MarkdownRenderer } from '../shared/MarkdownRenderer.tsx';
import { stripMarkdown } from '../shared/stripMarkdown.ts';
import { AttachmentRenderer } from './AttachmentRenderer.tsx';
import { DeleteMessageDialog } from './DeleteMessageDialog.tsx';
import { EmojiPicker } from './EmojiPicker.tsx';
import { LinkPreviewCard } from './LinkPreviewCard.tsx';
import { MemberList } from './MemberList.tsx';
import { MessageComposer } from './MessageComposer.tsx';
import { MessageContextMenu } from './MessageContextMenu.tsx';
import { PinnedMessagesPanel } from './PinnedMessagesPanel.tsx';
import { ReactionBar } from './ReactionBar.tsx';
import { TypingIndicator } from './TypingIndicator.tsx';

type Message = MessageState['byChannel'][string][number];

const EMPTY_MESSAGES: Message[] = [];

/** Scroll to a message element and apply a brief highlight animation. */
function highlightAndScroll(
  scrollContainer: HTMLElement,
  messageId: string,
  highlightRef: React.MutableRefObject<{ el: Element; timer: number } | null>,
) {
  const el = scrollContainer.querySelector(`[data-message-id="${messageId}"]`);
  if (!el) return;

  // Clean up previous highlight
  if (highlightRef.current) {
    highlightRef.current.el.classList.remove('highlight-flash');
    clearTimeout(highlightRef.current.timer);
  }

  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('highlight-flash');
  const timer = window.setTimeout(() => {
    el.classList.remove('highlight-flash');
    highlightRef.current = null;
  }, 2000);
  highlightRef.current = { el, timer };
}

function useCanManageMessages(
  serverId: string | undefined,
  currentUserId: string | undefined,
): boolean {
  const ownerId = useServerStore((s) =>
    serverId ? s.servers[serverId]?.ownerId : undefined,
  );
  const isOwner = !!(currentUserId && currentUserId === ownerId);
  return useMemberStore((s) => {
    if (!serverId || !currentUserId) return false;
    if (isOwner) return true;
    const member = s.byServer[serverId]?.find(
      (m) => m.userId === currentUserId,
    );
    if (!member) return false;
    const roles = useRoleStore.getState().byServer[serverId];
    if (!roles) return false;
    let combined = 0n;
    for (const role of roles) {
      if (member.roleIds.includes(role.id)) combined |= role.permissions;
    }
    return hasPermission(combined, Permissions.MANAGE_MESSAGES);
  });
}

interface ChannelViewProps {
  channelId: string;
  showMembers?: boolean;
  showPins?: boolean;
  serverId?: string;
  onTogglePins?: () => void;
}

export function ChannelView({
  channelId,
  showMembers,
  showPins,
  serverId,
  onTogglePins,
}: ChannelViewProps) {
  const messages = useMessageStore(
    (s) => s.byChannel[channelId] ?? EMPTY_MESSAGES,
  );
  const isLoading = useMessageStore((s) => !!s.isLoading[channelId]);
  const error = useMessageStore((s) => s.error[channelId]);
  const viewMode = useMessageStore((s) => s.viewMode[channelId] ?? 'live');
  const currentUser = useAuthStore((s) => s.user);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);
  const lastAckedIdRef = useRef<string | null>(null);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const _reconnectCount = useGatewayStore((s) => s.reconnectCount);
  const needsEncryption = true; // Universal E2EE: all channels encrypted
  const { isEncrypted: keysAvailable } = useChannelEncryption(channelId);
  const hasEmojis = useEmojiStore((s) =>
    serverId ? !!s.byServer[serverId] : true,
  );
  const hasMembers = useMemberStore((s) =>
    serverId ? !!s.byServer[serverId] : true,
  );
  const hasRoles = useRoleStore((s) =>
    serverId ? !!s.byServer[serverId] : true,
  );

  // Compute whether the current user can manage (delete) other users' messages
  const canManageMessages = useCanManageMessages(serverId, currentUser?.id);

  // Track this channel as "viewed" so notification sounds and unread
  // increments are suppressed while the pane is mounted.
  useEffect(() => {
    useGatewayStore.getState().addViewedChannel(channelId);
    return () => useGatewayStore.getState().removeViewedChannel(channelId);
  }, [channelId]);

  // Periodic tick to refresh relative timestamps (every 60s)
  const [timeTick, setTimeTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTimeTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // Jump-to-message refs
  const jumpTargetRef = useRef<string | null>(null);
  const highlightRef = useRef<{ el: Element; timer: number } | null>(null);
  const jumpGeneration = useRef(0);
  const [_scrollTick, setScrollTick] = useState(0);

  // Single-edit-at-a-time management
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [pendingEditId, setPendingEditId] = useState<string | null>(null);
  const [discardDialogOpen, setDiscardDialogOpen] = useState(false);
  const editDirtyRef = useRef(false);

  const setEditDirty = useCallback((dirty: boolean) => {
    editDirtyRef.current = dirty;
  }, []);

  const requestEdit = useCallback(
    (messageId: string) => {
      if (
        editingMessageId &&
        editingMessageId !== messageId &&
        editDirtyRef.current
      ) {
        setPendingEditId(messageId);
        setDiscardDialogOpen(true);
      } else {
        setEditingMessageId(messageId);
      }
    },
    [editingMessageId],
  );

  const cancelEdit = useCallback(() => {
    editDirtyRef.current = false;
    setEditingMessageId(null);
  }, []);

  // Cancel edit on Escape (document-level, but not when discard dialog is open)
  useEffect(() => {
    if (!editingMessageId || discardDialogOpen) return;
    function handleKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') {
        if (editDirtyRef.current) {
          setPendingEditId(null);
          setDiscardDialogOpen(true);
        } else {
          setEditingMessageId(null);
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [editingMessageId, discardDialogOpen]);

  // Reset acked ref when switching channels
  // biome-ignore lint/correctness/useExhaustiveDependencies: channelId triggers reset on channel switch
  useEffect(() => {
    lastAckedIdRef.current = null;
  }, [channelId]);

  // Snapshot the last-read message ID when entering a channel so the
  // "New Activity" divider stays stable until the user navigates away
  // or presses Escape.
  const [newActivityAnchor, setNewActivityAnchor] = useState<string | null>(
    null,
  );
  useEffect(() => {
    const rs = useReadStateStore.getState().byChannel[channelId];
    setNewActivityAnchor(
      rs && rs.unreadCount > 0 ? rs.lastReadMessageId : null,
    );
  }, [channelId]);

  // Escape clears the "New Activity" divider (when not editing a message)
  useEffect(() => {
    if (!newActivityAnchor || editingMessageId) return;
    function handleKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') {
        setNewActivityAnchor(null);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [newActivityAnchor, editingMessageId]);

  useEffect(() => {
    if (!isAuthenticated) return;
    let ignore = false;
    getMessages(channelId)
      .then(async (res) => {
        if (ignore || !res?.messages.length) return;
        const ids = res.messages.map((m: { id: string }) => m.id);
        getReactions(channelId, ids).catch(() => {});
        // Background-index historical messages for local search
        backfillChannel(channelId).catch(() => {});

        // Decrypt historical messages for encrypted channels
        if (needsEncryption && isSessionReady()) {
          if (!hasChannelKey(channelId)) {
            try {
              await fetchAndCacheChannelKeys(channelId);
            } catch {}
          }
          if (hasChannelKey(channelId)) {
            const encrypted = res.messages.filter(
              (m: { keyVersion: number }) => m.keyVersion > 0,
            );
            if (encrypted.length === 0) return;
            const authorIds = [
              ...new Set(
                encrypted.map((m: { authorId: string }) => m.authorId),
              ),
            ];
            let pubKeys: Record<string, Uint8Array> = {};
            try {
              pubKeys = await getPublicKeys(authorIds);
            } catch {}
            if (!ignore) {
              await decryptAndUpdateMessages(channelId, encrypted, pubKeys);
            }
          }
        }
      })
      .catch(() => {
        if (!ignore) {
          /* error already set in store */
        }
      });
    return () => {
      ignore = true;
    };
  }, [channelId, isAuthenticated]); // eslint-disable-line react-hooks/exhaustive-deps -- reconnectCount is an intentional trigger

  // Re-decrypt historical messages once channel keys become available.
  // Handles the case where keys arrive after messages were already fetched
  // (e.g., key distribution from channel creator hadn't completed yet).
  // Uses batched update to avoid per-message re-renders.
  useEffect(() => {
    if (!keysAvailable || !needsEncryption || !channelId) return;
    const messages = useMessageStore.getState().byChannel[channelId] ?? [];
    const encrypted = messages.filter(
      (m: { keyVersion: number }) => m.keyVersion > 0,
    );
    if (encrypted.length === 0) return;

    let cancelled = false;
    (async () => {
      const authorIds = [
        ...new Set(encrypted.map((m: { authorId: string }) => m.authorId)),
      ] as string[];
      let pubKeys: Record<string, Uint8Array> = {};
      try {
        pubKeys = await getPublicKeys(authorIds);
      } catch {
        return;
      }
      if (!cancelled) {
        await decryptAndUpdateMessages(channelId, encrypted, pubKeys);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [keysAvailable, channelId]);

  // Fetch server emojis so MarkdownRenderer can resolve emoji tags in messages.
  useEffect(() => {
    if (!isAuthenticated || !serverId || hasEmojis) return;
    listEmojis(serverId).catch(() => {});
  }, [serverId, isAuthenticated, hasEmojis]);

  // Fetch personal emojis so MarkdownRenderer can resolve personal emoji tags.
  const hasPersonalEmojis = useEmojiStore((s) => s.personal.length > 0);
  useEffect(() => {
    if (!isAuthenticated || hasPersonalEmojis) return;
    listUserEmojis().catch(() => {});
  }, [isAuthenticated, hasPersonalEmojis]);

  // Fetch server members so MessageItem can resolve author display names.
  useEffect(() => {
    if (!isAuthenticated || !serverId || hasMembers) return;
    listMembers(serverId).catch(() => {});
  }, [serverId, isAuthenticated, hasMembers]);

  // Fetch server roles so MentionAutocomplete and MentionBadge can resolve roles.
  useEffect(() => {
    if (!isAuthenticated || !serverId || hasRoles) return;
    listRoles(serverId).catch(() => {});
  }, [serverId, isAuthenticated, hasRoles]);

  // Ack the latest message when the user is at the bottom of the scroll
  const ackLatest = useCallback(() => {
    if (!isAuthenticated || !messages.length) return;
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastAckedIdRef.current === lastMsg.id) return;
    lastAckedIdRef.current = lastMsg.id;
    useReadStateStore.getState().updateReadState(channelId, lastMsg.id, 0);
    ackMessage(channelId, lastMsg.id).catch(() => {});
  }, [channelId, isAuthenticated, messages]);

  // When new messages arrive and user is at bottom, auto-ack
  useEffect(() => {
    if (wasNearBottomRef.current && messages.length > 0) {
      ackLatest();
    }
  }, [messages.length, ackLatest]);

  // Batch-fetch missing parent messages for reply previews
  const fetchedParentsRef = useRef(new Set<string>());
  useEffect(() => {
    const byId = useMessageStore.getState().byId[channelId];
    const missing: string[] = [];
    for (const msg of messages) {
      if (
        msg.replyToId &&
        !byId?.[msg.replyToId] &&
        !fetchedParentsRef.current.has(msg.replyToId)
      ) {
        missing.push(msg.replyToId);
      }
    }
    if (missing.length === 0) return;
    // Mark as fetching to prevent duplicate requests
    for (const id of missing) {
      fetchedParentsRef.current.add(id);
    }
    getMessagesByIDs({ channelId, messageIds: missing })
      .then((fetched) => {
        // Add fetched messages to byId without adding to byChannel (they're out of order)
        const store = useMessageStore.getState();
        for (const msg of fetched) {
          if (!store.byId[channelId]?.[msg.id]) {
            // Directly update byId via the store's set
            useMessageStore.setState((state) => {
              if (!state.byId[channelId]) {
                state.byId[channelId] = {};
              }
              state.byId[channelId][msg.id] = msg;
            });
          }
        }
      })
      .catch(() => {
        // Remove from fetched set so they can be retried
        for (const id of missing) {
          fetchedParentsRef.current.delete(id);
        }
      });
  }, [channelId, messages]);

  // Clear reply state on channel switch (Phase 5e)
  const prevChannelRef = useRef(channelId);
  useEffect(() => {
    if (prevChannelRef.current !== channelId) {
      useMessageStore.getState().setReplyingTo(prevChannelRef.current, null);
      prevChannelRef.current = channelId;
      fetchedParentsRef.current = new Set();
    }
  }, [channelId]);

  // Auto-scroll to bottom on new messages or content changes (e.g. decryption
  // resolving placeholder → real text), or scroll to a jump target.
  // biome-ignore lint/correctness/useExhaustiveDependencies: _scrollTick is an intentional trigger to re-run this effect when scrollToMessage is called; messages triggers it when decryption updates content heights
  useLayoutEffect(() => {
    if (jumpTargetRef.current && scrollRef.current) {
      highlightAndScroll(
        scrollRef.current,
        jumpTargetRef.current,
        highlightRef,
      );
      jumpTargetRef.current = null;
      return;
    }
    if (wasNearBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, _scrollTick]);

  const scrollToMessage = useCallback(
    async (messageId: string) => {
      const gen = ++jumpGeneration.current;
      const msgStore = useMessageStore.getState();

      // Case 1: Message already loaded
      if (msgStore.byId[channelId]?.[messageId]) {
        if (gen !== jumpGeneration.current) return;
        jumpTargetRef.current = messageId;
        setScrollTick((t) => t + 1);
        return;
      }

      // Case 2: Fetch around target
      const res = await getMessages(channelId, { around: messageId });
      if (gen !== jumpGeneration.current) return;

      if (res.messages.some((m: { id: string }) => m.id === messageId)) {
        msgStore.setViewMode(channelId, 'historical');
        jumpTargetRef.current = messageId;
        setScrollTick((t) => t + 1);
      }
    },
    [channelId],
  );

  const handleReply = useCallback(
    (msg: Message) => {
      useMessageStore.getState().setReplyingTo(channelId, msg);
    },
    [channelId],
  );

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 100;
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    wasNearBottomRef.current = nearBottom;
    if (nearBottom) ackLatest();
  }

  return (
    <div className="flex flex-1 min-h-0 min-w-0">
      <div className="flex flex-1 flex-col min-h-0 min-w-0">
        {/* Message list */}
        <div
          ref={scrollRef}
          className="flex flex-1 flex-col overflow-y-auto px-4 pt-2 pb-4"
          onScroll={handleScroll}
          onTouchStart={() => {
            // On mobile, tapping the message list dismisses the keyboard
            const active = document.activeElement;
            if (active instanceof HTMLTextAreaElement) active.blur();
          }}
          data-testid="message-list"
        >
          {isLoading && messages.length === 0 && (
            <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
              Loading messages…
            </div>
          )}

          {!isLoading && messages.length === 0 && (
            <div className="flex flex-1 items-end justify-center pb-2 text-sm text-text-muted">
              No messages yet. Start the conversation!
            </div>
          )}

          <div className="mt-auto">
            {messages.map((msg, idx) => (
              <Fragment key={msg.id}>
                {newActivityAnchor &&
                  idx > 0 &&
                  messages[idx - 1]?.id === newActivityAnchor && (
                    <div className="my-2 flex items-center gap-3">
                      <div className="h-px flex-1 bg-accent" />
                      <span className="text-xs font-semibold text-accent">
                        New Activity
                      </span>
                      <div className="h-px flex-1 bg-accent" />
                    </div>
                  )}
                <MessageItem
                  msg={msg}
                  channelId={channelId}
                  currentUserId={currentUser?.id}
                  serverId={serverId}
                  needsEncryption={needsEncryption}
                  timeTick={timeTick}
                  isEditing={editingMessageId === msg.id}
                  onStartEdit={() => requestEdit(msg.id)}
                  onCancelEdit={cancelEdit}
                  onEditDirtyChange={setEditDirty}
                  onReply={() => handleReply(msg)}
                  onJumpToMessage={scrollToMessage}
                  canManageMessages={canManageMessages}
                />
              </Fragment>
            ))}
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="flex-shrink-0 border-t border-border bg-error/10 px-4 py-2 text-xs text-error">
            {error}
          </div>
        )}

        {/* Typing indicator */}
        <div className="flex-shrink-0">
          <TypingIndicator channelId={channelId} serverId={serverId} />
        </div>

        {/* Return to Present button */}
        {viewMode === 'historical' && (
          <div className="flex justify-center py-1 flex-shrink-0">
            <button
              type="button"
              className="rounded-full bg-accent px-4 py-1.5 text-xs font-medium text-white shadow-md hover:bg-accent-hover transition-colors"
              onClick={async () => {
                useMessageStore.getState().returnToPresent(channelId);
                await getMessages(channelId);
              }}
            >
              Return to Present
            </button>
          </div>
        )}

        {/* Message input — replaced with key status bar when keys unavailable */}
        {needsEncryption && !keysAvailable ? (
          <div className="flex flex-shrink-0 items-center gap-3 border-t border-border px-4 py-3">
            <LockKeyIcon
              size={18}
              className="flex-shrink-0 text-text-muted"
              aria-hidden="true"
            />
            <p className="text-sm text-text-muted">
              <span className="font-medium text-accent">
                {"You're almost there! "}
              </span>
              {isSessionReady()
                ? 'Waiting for encryption keys — an online member will share them with you shortly.'
                : 'Loading your encryption keys — this only takes a moment.'}
            </p>
          </div>
        ) : (
          <MessageComposer
            channelId={channelId}
            serverId={serverId}
            disabled={viewMode === 'historical'}
          />
        )}
      </div>

      {/* Pinned messages sidebar */}
      {showPins && (
        <PinnedMessagesPanel
          channelId={channelId}
          serverId={serverId}
          canUnpin
          onClose={() => onTogglePins?.()}
          onJumpToMessage={scrollToMessage}
        />
      )}

      {/* Member list sidebar */}
      {showMembers && serverId && (
        <div className="w-52 flex-shrink-0 border-l border-border overflow-y-auto">
          <MemberList serverId={serverId} />
        </div>
      )}

      {/* Discard edit confirmation dialog */}
      <Dialog.Root
        open={discardDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setPendingEditId(null);
            setDiscardDialogOpen(false);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/60 animate-fade-in" />
          <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl bg-bg-elevated p-6 shadow-lg animate-scale-in">
            <Dialog.Title className="text-lg font-semibold text-text">
              Discard Changes
            </Dialog.Title>
            <p className="mt-2 text-sm text-text-muted">
              You have unsaved edits. Discard your changes?
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-md bg-bg-surface px-3 py-1.5 text-sm text-text-muted hover:bg-bg-elevated hover:text-text"
                >
                  Keep Editing
                </button>
              </Dialog.Close>
              <button
                type="button"
                className="rounded-md bg-error px-4 py-2 text-sm font-medium text-white hover:bg-error/80"
                onClick={() => {
                  editDirtyRef.current = false;
                  setEditingMessageId(pendingEditId);
                  setPendingEditId(null);
                  setDiscardDialogOpen(false);
                }}
              >
                Discard
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

/** Resolve author display name via the shared fallback chain. */
function useAuthorName(authorId: string, serverId: string | undefined) {
  return useDisplayName(authorId, serverId);
}

// --- Encrypted attachment placeholder (reserves layout space before decrypt) ---

/** Mirrors the ImageGrid + AttachmentRenderer layout with skeleton placeholders. */
function EncryptedAttachmentPlaceholder({
  attachments,
}: {
  attachments: Attachment[];
}) {
  const images = attachments.filter((a) => a.contentType.startsWith('image/'));
  const nonImages = attachments.filter(
    (a) => !a.contentType.startsWith('image/'),
  );

  return (
    <div className="mt-1 flex flex-col gap-2">
      {images.length === 1 && <SingleImagePlaceholder attachment={images[0]} />}
      {images.length > 1 && <ImageGridPlaceholder images={images} />}
      {nonImages.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {nonImages.map((att) =>
            att.contentType.startsWith('video/') ? (
              <SingleImagePlaceholder key={att.id} attachment={att} />
            ) : (
              <div
                key={att.id}
                className="flex h-12 w-60 items-center gap-2 rounded-md border border-border bg-bg-surface px-3"
              >
                <div className="h-4 w-4 rounded bg-bg-elevated" />
                <div className="h-3 flex-1 rounded bg-bg-elevated" />
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** Single image/video: constrained aspect ratio, same as ImageAttachment. */
function SingleImagePlaceholder({ attachment }: { attachment: Attachment }) {
  const hasAspectRatio = attachment.width > 0 && attachment.height > 0;
  return (
    <div
      className="rounded-md bg-bg-surface overflow-hidden"
      style={
        hasAspectRatio
          ? {
              aspectRatio: `${attachment.width}/${attachment.height}`,
              maxWidth: Math.min(400, attachment.width),
              maxHeight: 300,
            }
          : { maxWidth: 400, maxHeight: 300, aspectRatio: '4/3' }
      }
    >
      {attachment.microThumbnail.length > 0 && (
        <img
          src={microThumbDataURI(attachment.microThumbnail)}
          alt=""
          aria-hidden="true"
          className="h-full w-full object-cover blur-xl scale-110"
        />
      )}
    </div>
  );
}

/** Multi-image grid: mirrors ImageGrid layout with square cells. */
function ImageGridPlaceholder({ images }: { images: Attachment[] }) {
  const count = images.length;
  const gridClass =
    count === 2
      ? 'grid grid-cols-2 gap-1'
      : count === 3
        ? 'grid grid-cols-2 grid-rows-2 gap-1'
        : 'grid grid-cols-2 gap-1';

  return (
    <div className={`${gridClass} max-w-[400px] rounded-md overflow-hidden`}>
      {images.map((img, i) => (
        <div
          key={img.id}
          className={`relative bg-bg-surface overflow-hidden ${count === 3 && i === 0 ? 'row-span-2' : ''}`}
          style={{ aspectRatio: count === 3 && i === 0 ? '1/2' : '1/1' }}
        >
          {img.microThumbnail.length > 0 && (
            <img
              src={microThumbDataURI(img.microThumbnail)}
              alt=""
              aria-hidden="true"
              className="h-full w-full object-cover blur-xl scale-110"
            />
          )}
        </div>
      ))}
    </div>
  );
}

/** Convert raw bytes to a base64 data URI for inline display. */
function microThumbDataURI(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return `data:image/webp;base64,${btoa(binary)}`;
}

// --- Scrambling "decrypting" placeholder (à la charmbracelet/mods) ---

const CIPHER =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' +
  '!@#$%^&*+-=~<>?' +
  'ｦｧｨｩｪｫｬｭｮｯｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ';

function scramble(len: number): string[] {
  const arr: string[] = [];
  for (let i = 0; i < len; i++) {
    arr.push(CIPHER[Math.floor(Math.random() * CIPHER.length)]);
  }
  return arr;
}

/** Placeholder with cycling characters, mimicking a cipher being decoded. */
function DecryptingText() {
  // Stable per-instance "shape": random word-lengths with spaces between them.
  const [layout] = useState(() => {
    const totalLen = 10 + Math.floor(Math.random() * 18);
    const spaces = new Set<number>();
    let pos = 3 + Math.floor(Math.random() * 4);
    while (pos < totalLen - 1) {
      spaces.add(pos);
      pos += 3 + Math.floor(Math.random() * 5);
    }
    return { totalLen, spaces };
  });

  const bufRef = useRef(scramble(layout.totalLen));
  const [chars, setChars] = useState(() => bufRef.current);

  useEffect(() => {
    const { totalLen, spaces } = layout;
    const buf = bufRef.current;
    const id = setInterval(() => {
      // Change ~30% of non-space characters per tick for a ripple effect
      for (let i = 0; i < totalLen; i++) {
        if (spaces.has(i)) continue;
        if (Math.random() < 0.3) {
          buf[i] = CIPHER[Math.floor(Math.random() * CIPHER.length)];
        }
      }
      setChars([...buf]);
    }, 70);
    return () => clearInterval(id);
  }, [layout]);

  const display = chars.map((c, i) => (layout.spaces.has(i) ? '\u2004' : c));

  return (
    <output
      className="inline-block font-mono text-sm text-text-muted/50 select-none"
      aria-label="Encrypted message"
    >
      {display.join('')}
    </output>
  );
}

/** Resolve author avatar URL from auth store (self) or users store (cached profiles). */
function useAuthorAvatar(authorId: string) {
  const ownAvatar = useAuthStore((s) =>
    s.user?.id === authorId ? s.user.avatarUrl : undefined,
  );
  const cachedAvatar = useUsersStore((s) => s.profiles[authorId]?.avatarUrl);
  return ownAvatar ?? cachedAvatar;
}

const MessageItem = memo(function MessageItem({
  msg,
  channelId,
  currentUserId,
  serverId,
  needsEncryption,
  timeTick: _timeTick,
  isEditing,
  onStartEdit,
  onCancelEdit,
  onEditDirtyChange,
  onReply,
  onJumpToMessage,
  canManageMessages,
}: {
  msg: Message;
  channelId: string;
  currentUserId: string | undefined;
  serverId: string | undefined;
  needsEncryption: boolean;
  timeTick: number;
  isEditing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onEditDirtyChange: (dirty: boolean) => void;
  onReply: () => void;
  onJumpToMessage: (messageId: string) => void;
  canManageMessages: boolean;
}) {
  const isOwn = msg.authorId === currentUserId;
  const isPinned = usePinStore((s) => !!s.pinnedIds[msg.channelId]?.[msg.id]);
  // Resolve message text. Gateway pre-decrypts real-time messages (keyVersion→0).
  // Historical messages are decrypted in the fetch effect above.
  // keyVersion > 0 means still encrypted; 0 means plaintext.
  const isStillEncrypted = needsEncryption && msg.keyVersion > 0;
  const text = useMemo(() => {
    // Always parse through safeParseMessageText to handle V1 JSON format.
    // This prevents raw JSON like {"t":"hello","a":{}} from leaking to the UI
    // when decryptInBackground updates the store after the first render.
    if (msg.encryptedContent.length > 0 && !isStillEncrypted) {
      return safeParseMessageText(msg.encryptedContent);
    }
    return '';
  }, [msg.encryptedContent, isStillEncrypted]);
  const memberName = useAuthorName(msg.authorId, serverId);
  const authorAvatar = useAuthorAvatar(msg.authorId);
  const authorLabel = memberName;
  const authorColor = useDisplayColor(msg.authorId, serverId);
  const time = msg.createdAt
    ? new Date(Number(msg.createdAt.seconds) * 1000)
    : null;

  // Reply preview: look up parent message from byId
  const parentMessage = useMessageStore((s) =>
    msg.replyToId ? (s.byId[channelId]?.[msg.replyToId] ?? null) : null,
  );
  const parentAuthorName = useAuthorName(
    parentMessage?.authorId ?? '',
    serverId,
  );

  // Replies accordion state
  const [accordionOpen, setAccordionOpen] = useState(false);
  const [replyEntries, setReplyEntries] = useState<ReplyEntry[] | null>(null);
  const [replyTotalCount, setReplyTotalCount] = useState(0);
  // Detect local replies: any loaded message with replyToId === this msg's id
  const hasLocalReplies = useMessageStore((s) => {
    const channelMsgs = s.byChannel[channelId];
    if (!channelMsgs) return false;
    return channelMsgs.some((m) => m.replyToId === msg.id);
  });

  function handleAccordionToggle() {
    if (accordionOpen) {
      setAccordionOpen(false);
      return;
    }
    setAccordionOpen(true);
    if (!replyEntries) {
      getReplies({ channelId, messageId: msg.id })
        .then((res) => {
          setReplyEntries(res.replies);
          setReplyTotalCount(res.totalCount);
        })
        .catch(() => {});
    }
  }

  const [editText, setEditText] = useState('');
  const [editError, setEditError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);

  // Initialize edit text when isEditing transitions to true (handles both
  // direct clicks and discard-dialog switches from ChannelView).
  const prevIsEditingRef = useRef(false);
  useLayoutEffect(() => {
    if (isEditing && !prevIsEditingRef.current) {
      setEditText(text);
      setEditError('');
    }
    prevIsEditingRef.current = isEditing;
  });

  // Report dirty state to ChannelView so it can decide whether to show
  // the discard dialog on Escape or when switching to another message.
  useEffect(() => {
    onEditDirtyChange(isEditing && editText !== text);
  }, [isEditing, editText, text, onEditDirtyChange]);

  const handleReactionSelect = useCallback(
    (emoji: string) => {
      setReactionPickerOpen(false);
      if (!currentUserId) return;
      useReactionStore
        .getState()
        .addReaction(msg.id, emoji, currentUserId, true);
      addReaction(msg.channelId, msg.id, emoji).catch(() => {
        useReactionStore
          .getState()
          // biome-ignore lint/style/noNonNullAssertion: guarded by early return above
          .removeReaction(msg.id, emoji, currentUserId!, true);
      });
    },
    [msg.channelId, msg.id, currentUserId],
  );

  function cancelEdit() {
    setEditText('');
    setEditError('');
    onCancelEdit();
  }

  async function saveEdit() {
    const trimmed = editText.trim();
    if (!trimmed || trimmed === text) {
      cancelEdit();
      return;
    }
    setIsSaving(true);
    setEditError('');
    try {
      // Use V1 JSON format for edited messages (preserves compatibility)
      const plaintext = buildMessageContent(trimmed);
      // Encrypt edited content for encrypted channels
      let content: Uint8Array;
      let keyVersion: number | undefined;
      if (needsEncryption) {
        try {
          const encrypted = await encryptMessage(channelId, plaintext);
          content = encrypted.data;
          keyVersion = encrypted.keyVersion;
        } catch {
          setEditError('Encryption failed');
          setIsSaving(false);
          return;
        }
      } else {
        content = plaintext;
      }
      await editMessage({
        channelId: msg.channelId,
        messageId: msg.id,
        encryptedContent: content,
        keyVersion,
      });
      onCancelEdit();
    } catch {
      setEditError('Failed to save edit');
    } finally {
      setIsSaving(false);
    }
  }

  function handleEditKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Escape is handled by the document-level listener in ChannelView
    // so it can check dirty state and show the discard dialog.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveEdit();
    }
  }

  useEffect(() => {
    if (isEditing && editRef.current) {
      editRef.current.focus();
      editRef.current.setSelectionRange(
        editRef.current.value.length,
        editRef.current.value.length,
      );
    }
  }, [isEditing]);

  return (
    <>
      <MessageContextMenu
        encryptedContent={msg.encryptedContent}
        isOwn={isOwn}
        isPinned={isPinned}
        canPin
        onReply={onReply}
        onEdit={onStartEdit}
        onDelete={() => setDeleteDialogOpen(true)}
        onPin={() => pinMessage(msg.channelId, msg.id)}
        onUnpin={() => unpinMessage(msg.channelId, msg.id)}
        onViewProfile={() => openProfilePane(msg.authorId)}
      >
        <div
          className="group relative rounded-md px-2 py-1 hover:bg-bg-surface/50 transition-colors"
          data-message-id={msg.id}
        >
          {/* Reply preview bar (shown above message content when this is a reply) */}
          {msg.replyToId && (
            <ReplyPreviewBar
              parentMessage={parentMessage}
              parentAuthorName={parentAuthorName}
              parentAuthorId={parentMessage?.authorId}
              serverId={serverId}
              onJump={() => {
                if (msg.replyToId) onJumpToMessage(msg.replyToId);
              }}
            />
          )}

          {/* Hover action buttons */}
          <div
            className={`absolute -top-2 right-4 flex items-center gap-0.5 rounded-md border border-border bg-bg-elevated px-1 py-0.5 shadow-sm transition-opacity ${reactionPickerOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
          >
            <button
              type="button"
              className="p-1 text-xs text-text-muted hover:text-text rounded"
              onClick={onReply}
              title="Reply"
            >
              &#x21A9;
            </button>
            <Popover.Root
              open={reactionPickerOpen}
              onOpenChange={setReactionPickerOpen}
            >
              <Popover.Trigger asChild>
                <button
                  type="button"
                  className="p-1 text-xs text-text-muted hover:text-text rounded"
                  title="Add reaction"
                >
                  <SmileyIcon size={14} aria-hidden="true" />
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  className="z-50 rounded-xl border border-border shadow-lg data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out"
                  side="top"
                  align="end"
                  sideOffset={8}
                  collisionPadding={16}
                >
                  <EmojiPicker
                    onEmojiSelect={handleReactionSelect}
                    serverId={serverId}
                  />
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
            {isOwn ? (
              <>
                <button
                  type="button"
                  className="p-1 text-xs text-text-muted hover:text-text rounded"
                  onClick={onStartEdit}
                  title="Edit"
                >
                  &#x270E;
                </button>
                <button
                  type="button"
                  className="p-1 text-xs text-text-muted hover:text-error rounded"
                  onClick={() => setDeleteDialogOpen(true)}
                  title="Delete"
                >
                  &#x1F5D1;
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="p-1 text-xs text-text-muted hover:text-text rounded"
                  onClick={() => {
                    navigator.clipboard.writeText(text);
                  }}
                  title="Copy"
                >
                  &#x1F4CB;
                </button>
                {canManageMessages && (
                  <button
                    type="button"
                    className="p-1 text-xs text-text-muted hover:text-error rounded"
                    onClick={() => setDeleteDialogOpen(true)}
                    title="Delete"
                  >
                    &#x1F5D1;
                  </button>
                )}
              </>
            )}
          </div>

          <div className="flex items-start gap-2">
            <ProfilePopoverCard userId={msg.authorId} serverId={serverId}>
              <button
                type="button"
                className="mt-0.5 flex-shrink-0 cursor-pointer"
              >
                <Avatar
                  avatarUrl={authorAvatar}
                  displayName={authorLabel}
                  size="md"
                />
              </button>
            </ProfilePopoverCard>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <ProfilePopoverCard userId={msg.authorId} serverId={serverId}>
                  <button
                    type="button"
                    className="text-sm font-medium cursor-pointer hover:underline text-text"
                    style={authorColor ? { color: authorColor } : undefined}
                  >
                    {authorLabel}
                  </button>
                </ProfilePopoverCard>
                {time && (
                  <span
                    className="text-xs text-text-subtle"
                    title={toISO(time)}
                  >
                    {formatRelativeTime(time)}
                  </span>
                )}
                {isPinned && (
                  <PushPinIcon
                    size={12}
                    className="text-text-muted inline"
                    aria-label="Pinned"
                  />
                )}
                {msg.editedAt && (
                  <span className="text-xs text-text-subtle">(edited)</span>
                )}
              </div>

              {isEditing ? (
                <div className="mt-1">
                  <textarea
                    ref={editRef}
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={handleEditKeyDown}
                    disabled={isSaving}
                    rows={1}
                    className="w-full resize-none rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none disabled:opacity-50"
                  />
                  {editError && (
                    <p className="text-xs text-error mt-1">{editError}</p>
                  )}
                  <div className="flex items-center gap-2 mt-1">
                    <button
                      type="button"
                      onClick={cancelEdit}
                      disabled={isSaving}
                      className="text-xs text-text-muted hover:text-text"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={saveEdit}
                      disabled={isSaving}
                      className="text-xs text-accent hover:text-accent-hover font-medium"
                    >
                      {isSaving ? 'Saving...' : 'Save'}
                    </button>
                    <span className="text-xs text-text-subtle">
                      escape to cancel &middot; enter to save
                    </span>
                  </div>
                </div>
              ) : isStillEncrypted ? (
                <>
                  <DecryptingText />
                  {msg.attachments.length > 0 && (
                    <EncryptedAttachmentPlaceholder
                      attachments={msg.attachments}
                    />
                  )}
                </>
              ) : (
                <>
                  {text && (
                    <MarkdownRenderer content={text} serverId={serverId} />
                  )}
                  {msg.embeds.length > 0 && (
                    <div className="flex flex-col gap-1">
                      {msg.embeds.map((embed, i) => (
                        <LinkPreviewCard key={embed.url || i} embed={embed} />
                      ))}
                    </div>
                  )}
                  {msg.attachments.length > 0 && (
                    <AttachmentRenderer
                      attachments={msg.attachments}
                      channelId={channelId}
                    />
                  )}
                </>
              )}

              <ReactionBar
                channelId={msg.channelId}
                messageId={msg.id}
                serverId={serverId}
              />

              {/* Replies accordion */}
              {hasLocalReplies && (
                <div className="mt-1">
                  <button
                    type="button"
                    className="text-xs text-accent hover:text-accent-hover font-medium"
                    onClick={handleAccordionToggle}
                  >
                    {accordionOpen
                      ? `Hide replies${replyTotalCount ? ` (${replyTotalCount})` : ''}`
                      : 'Replies'}
                  </button>
                  {accordionOpen && (
                    <div className="mt-1 ml-2 border-l-2 border-border pl-2 space-y-0.5">
                      {replyEntries ? (
                        <>
                          <div className="text-xs text-text-muted mb-1">
                            {replyTotalCount}{' '}
                            {replyTotalCount === 1 ? 'reply' : 'replies'}
                          </div>
                          {replyEntries.map((entry) => (
                            <ReplyAccordionEntry
                              key={entry.messageId}
                              entry={entry}
                              channelId={channelId}
                              serverId={serverId}
                              onJump={() => onJumpToMessage(entry.messageId)}
                            />
                          ))}
                        </>
                      ) : (
                        <span className="text-xs text-text-subtle">
                          Loading…
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
            {/* end content column */}
          </div>
          {/* end avatar + content row */}
        </div>
      </MessageContextMenu>

      <DeleteMessageDialog
        channelId={msg.channelId}
        messageId={msg.id}
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
      />
    </>
  );
});

/** Compact reply preview bar shown above a message that is a reply. */
function ReplyPreviewBar({
  parentMessage,
  parentAuthorName,
  parentAuthorId,
  serverId,
  onJump,
}: {
  parentMessage: Message | null;
  parentAuthorName: string;
  parentAuthorId: string | undefined;
  serverId: string | undefined;
  onJump: () => void;
}) {
  const parentColor = useDisplayColor(parentAuthorId ?? '', serverId);
  const parentText = useMemo(
    () =>
      parentMessage ? safeParseMessageText(parentMessage.encryptedContent) : '',
    [parentMessage],
  );

  if (!parentMessage) {
    return (
      <div className="mb-0.5 text-xs text-text-subtle italic">
        Original message not available
      </div>
    );
  }

  const parentLabel = parentAuthorName;
  const snippet = stripMarkdown(parentText).slice(0, 80);

  return (
    <button
      type="button"
      className="mb-0.5 flex items-center gap-1.5 text-xs text-text-muted hover:text-text cursor-pointer border-l-2 border-text-subtle pl-2 w-full text-left"
      onClick={onJump}
    >
      <span
        className="font-medium text-text-muted"
        style={parentColor ? { color: parentColor } : undefined}
      >
        {parentLabel}
      </span>
      <span className="truncate text-text-subtle">
        {snippet || 'Original message was deleted'}
      </span>
    </button>
  );
}

/** A single entry in the replies accordion. */
function ReplyAccordionEntry({
  entry,
  channelId,
  serverId,
  onJump,
}: {
  entry: ReplyEntry;
  channelId: string;
  serverId: string | undefined;
  onJump: () => void;
}) {
  const authorName = useAuthorName(entry.authorId, serverId);
  const authorColor = useDisplayColor(entry.authorId, serverId);
  const label = authorName;
  const time = entry.createdAt
    ? new Date(Number(entry.createdAt.seconds) * 1000)
    : null;

  // Check if this message is in the local store for jump capability
  const isLocal = useMessageStore(
    (s) => !!s.byId[channelId]?.[entry.messageId],
  );

  return (
    <div className="flex items-center gap-2 text-xs">
      <span
        className="font-medium text-text"
        style={authorColor ? { color: authorColor } : undefined}
      >
        {label}
      </span>
      {time && (
        <span className="text-text-subtle">{formatRelativeTime(time)}</span>
      )}
      {isLocal ? (
        <button
          type="button"
          className="text-accent hover:text-accent-hover"
          onClick={onJump}
        >
          Jump
        </button>
      ) : (
        <span className="text-text-subtle" title="Message not in view">
          —
        </span>
      )}
    </div>
  );
}
