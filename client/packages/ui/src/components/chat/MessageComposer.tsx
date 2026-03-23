import type { EncryptedUploadResult, UploadedFile } from '@meza/core';
import {
  buildMessageContent,
  gatewaySendTyping,
  safeParseMessageText,
  sendMessage,
  uploadEncryptedFile,
  useChannelStore,
  useMessageStore,
} from '@meza/core';
import {
  EyeIcon,
  EyeSlashIcon,
  FileIcon,
  PaperclipIcon,
  PaperPlaneRightIcon,
  XIcon,
} from '@phosphor-icons/react';
import { ProsemirrorAdapterProvider } from '@prosemirror-adapter/react';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import { getCommand } from '../../commands/index.ts';
import { useChannelEncryption } from '../../hooks/useChannelEncryption.ts';
import { useDisplayName } from '../../hooks/useDisplayName.ts';
import { useMobile } from '../../hooks/useMobile.ts';
import { stripMarkdown } from '../shared/stripMarkdown.ts';
import { ChannelAutocomplete } from './ChannelAutocomplete.tsx';
import type { AutocompleteState } from './composer/ComposerEditor.tsx';
import type { ComposerEditorHandle } from './composer/schema.ts';
import { EmojiAutocomplete } from './EmojiAutocomplete.tsx';
import { EmojiPickerButton } from './EmojiPickerButton.tsx';
import { GifPicker } from './GifPicker.tsx';
import { MentionAutocomplete } from './MentionAutocomplete.tsx';
import { SlashCommandAutocomplete } from './SlashCommandAutocomplete.tsx';

// Lazy-load ProseMirror chunk (~50KB gzipped)
const ComposerEditor = lazy(() =>
  import('./composer/ComposerEditor.tsx').then((m) => ({
    default: m.ComposerEditor,
  })),
);

function extractMentions(text: string) {
  const userMentions = [...text.matchAll(/<@([A-Z0-9]{26})>/g)].map(
    (m) => m[1],
  );
  const roleMentions = [...text.matchAll(/<@&([A-Z0-9]{26})>/g)].map(
    (m) => m[1],
  );
  return {
    mentionedUserIds: [...new Set(userMentions)],
    mentionedRoleIds: [...new Set(roleMentions)],
    mentionEveryone: text.includes('@everyone'),
  };
}

const MAX_FILES = 10;
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const ACCEPTED_TYPES =
  'image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm,application/pdf,application/zip,text/plain,audio/mpeg,audio/ogg,audio/wav';

interface PendingFile {
  id: string;
  file: File;
  preview: string | null;
  progress: number; // 0-100
  error: string | null;
  isSpoiler: boolean;
}

interface MessageComposerProps {
  channelId: string;
  serverId?: string;
  disabled?: boolean;
  /** Mobile-only: whether the emoji panel is open below the composer. */
  mobileEmojiOpen?: boolean;
  /** Mobile-only: toggle the emoji panel. */
  onMobileEmojiToggle?: () => void;
  /** Ref that ChannelView uses to call insertEmoji from the mobile panel. */
  insertEmojiRef?: React.MutableRefObject<((text: string) => void) | null>;
}

export function MessageComposer({
  channelId,
  serverId,
  disabled,
  mobileEmojiOpen,
  onMobileEmojiToggle,
  insertEmojiRef,
}: MessageComposerProps) {
  const [sending, setSending] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [gifPickerQuery, setGifPickerQuery] = useState<string | null>(null);
  const [autocomplete, setAutocomplete] = useState<AutocompleteState>({
    trigger: null,
    query: '',
    range: null,
  });
  const sendingRef = useRef(false);
  const editorRef = useRef<ComposerEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resolvedServerId = useChannelStore(
    (s) => serverId || s.channelToServer[channelId],
  );
  const channel = useChannelStore((s) =>
    resolvedServerId
      ? s.byServer[resolvedServerId]?.find((c) => c.id === channelId)
      : undefined,
  );
  const channelName = channel?.name;
  const isMobile = useMobile();
  const {
    encrypt,
    ready: encryptionReady,
    isEncrypted,
    retry: retryEncryption,
    unavailableReason,
  } = useChannelEncryption(channelId);

  const replyingTo = useMessageStore((s) => s.replyingTo[channelId] ?? null);
  const replyAuthorName = useDisplayName(replyingTo?.authorId ?? '', serverId);

  // Expose insertEmoji to ChannelView for the mobile emoji panel
  useEffect(() => {
    if (insertEmojiRef) {
      insertEmojiRef.current = (text: string) => {
        editorRef.current?.insertText(text);
      };
    }
    return () => {
      if (insertEmojiRef) insertEmojiRef.current = null;
    };
  }, [insertEmojiRef]);

  // Revoke outstanding object URLs on unmount
  const pendingFilesRef = useRef(pendingFiles);
  pendingFilesRef.current = pendingFiles;
  useEffect(() => {
    return () => {
      for (const pf of pendingFilesRef.current) {
        if (pf.preview) URL.revokeObjectURL(pf.preview);
      }
    };
  }, []);

  function addFiles(files: FileList) {
    const currentCount = pendingFiles.length;
    const toAdd: PendingFile[] = [];
    for (
      let i = 0;
      i < files.length && currentCount + toAdd.length < MAX_FILES;
      i++
    ) {
      const file = files[i];
      if (file.size > MAX_FILE_SIZE) continue;
      const preview = file.type.startsWith('image/')
        ? URL.createObjectURL(file)
        : null;
      toAdd.push({
        id: crypto.randomUUID(),
        file,
        preview,
        progress: 0,
        error: null,
        isSpoiler: false,
      });
    }
    if (toAdd.length > 0) {
      setPendingFiles((prev) => [...prev, ...toAdd]);
    }
  }

  function removeFile(id: string) {
    setPendingFiles((prev) => {
      const removed = prev.find((f) => f.id === id);
      if (removed?.preview) URL.revokeObjectURL(removed.preview);
      return prev.filter((f) => f.id !== id);
    });
  }

  function toggleSpoiler(id: string) {
    setPendingFiles((prev) =>
      prev.map((f) => (f.id === id ? { ...f, isSpoiler: !f.isSpoiler } : f)),
    );
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files);
    }
    e.target.value = '';
  }

  function cancelReply() {
    useMessageStore.getState().setReplyingTo(channelId, null);
  }

  const handleSend = useCallback(
    async (overrideText?: string) => {
      let text = overrideText ?? '';

      // If no override, get text from the editor
      if (!overrideText) {
        // For now we get wire text passed from ComposerEditor's onSend
        return;
      }

      // Intercept slash commands
      if (text.startsWith('/')) {
        const match = text.match(/^\/(\S+)\s*(.*)/);
        if (match) {
          const [, commandName, args] = match;
          const command = getCommand(commandName);
          if (command) {
            if (commandName === 'gif') {
              setGifPickerQuery(args || '');
              editorRef.current?.clear();

              return;
            }
            if (command.silent) {
              command.execute(args, {
                channelId,
                serverId,
                sendMessage: () => {},
              });
              editorRef.current?.clear();

              return;
            }
            let transformed: string | null = null;
            command.execute(args, {
              channelId,
              serverId,
              sendMessage: (msg) => {
                transformed = msg;
              },
            });
            if (transformed !== null) {
              text = transformed;
            } else {
              editorRef.current?.clear();

              return;
            }
          }
        }
      }

      text = text.trim();
      const hasFiles = pendingFiles.length > 0;
      if ((!text && !hasFiles) || sendingRef.current) return;
      sendingRef.current = true;
      setSending(true);

      try {
        // Upload files
        const encryptedResults: EncryptedUploadResult[] = [];
        const uploadedFiles: UploadedFile[] = [];
        let hasErrors = false;

        for (const pf of pendingFiles) {
          try {
            const result = await uploadEncryptedFile(
              pf.file,
              channelId,
              (percent) => {
                setPendingFiles((prev) =>
                  prev.map((f) =>
                    f.id === pf.id ? { ...f, progress: percent } : f,
                  ),
                );
              },
              pf.isSpoiler,
            );
            encryptedResults.push(result);
            uploadedFiles.push({
              attachmentId: result.attachmentId,
              filename: result.filename,
              contentType: result.contentType,
              sizeBytes: result.sizeBytes,
              url: '',
              hasThumbnail: result.microThumbnail.length > 0,
              width: result.width,
              height: result.height,
              microThumbnail: result.microThumbnail,
            });
          } catch {
            hasErrors = true;
            setPendingFiles((prev) =>
              prev.map((f) =>
                f.id === pf.id
                  ? { ...f, error: 'Upload failed', progress: 0 }
                  : f,
              ),
            );
            break;
          }
        }

        if (hasErrors && uploadedFiles.length === 0) return;

        const attachmentMeta =
          encryptedResults.length > 0
            ? new Map(
                encryptedResults.map((r) => [
                  r.attachmentId,
                  {
                    microThumb: r.microThumbnail,
                    filename: r.filename,
                    contentType: r.contentType,
                  },
                ]),
              )
            : undefined;

        const plaintext = buildMessageContent(text, attachmentMeta);
        const encrypted = await encrypt(plaintext);
        if (!encrypted) return;
        const encryptedContent = encrypted.data;
        const keyVersion = encrypted.keyVersion;
        const { mentionedUserIds, mentionedRoleIds, mentionEveryone } =
          extractMentions(text);
        await sendMessage({
          channelId,
          encryptedContent,
          keyVersion,
          nonce: '',
          plaintext,
          uploadedFiles: uploadedFiles.length > 0 ? uploadedFiles : undefined,
          replyToId: replyingTo?.id,
          mentionedUserIds:
            mentionedUserIds.length > 0 ? mentionedUserIds : undefined,
          mentionedRoleIds:
            mentionedRoleIds.length > 0 ? mentionedRoleIds : undefined,
          mentionEveryone: mentionEveryone || undefined,
        });

        for (const pf of pendingFiles) {
          if (pf.preview) URL.revokeObjectURL(pf.preview);
        }

        setPendingFiles([]);
        if (replyingTo) {
          useMessageStore.getState().setReplyingTo(channelId, null);
        }
      } catch {
        // Error set in store
      } finally {
        sendingRef.current = false;
        flushSync(() => setSending(false));
        editorRef.current?.focus();
      }
    },
    [channelId, serverId, encrypt, pendingFiles, replyingTo],
  );

  // Handler for ComposerEditor onSend callback
  const handleEditorSend = useCallback(
    (wireText: string) => {
      handleSend(wireText);
    },
    [handleSend],
  );

  const handleTyping = useCallback(() => {
    gatewaySendTyping(channelId);
  }, [channelId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: cancelReply is a stable local function
  const handleCancel = useCallback(() => {
    if (replyingTo) {
      cancelReply();
    }
  }, [replyingTo]);

  // Truncate reply preview text
  const replyPreviewText = replyingTo
    ? stripMarkdown(safeParseMessageText(replyingTo.encryptedContent)).slice(
        0,
        100,
      )
    : '';

  const needsEncryption = true;
  const encryptionPending = needsEncryption && !encryptionReady;
  const encryptionUnavailable =
    needsEncryption && encryptionReady && !isEncrypted;

  const placeholderText = encryptionPending
    ? 'Setting up encryption\u2026'
    : encryptionUnavailable
      ? 'Encryption unavailable'
      : replyingTo
        ? 'Type a reply\u2026'
        : channelName
          ? `Message #${channelName}`
          : 'Type a message\u2026';

  return (
    <div className="flex-shrink-0 px-2 pt-1 pb-2">
      {/* Encryption retry banner */}
      {encryptionUnavailable && (
        <div className="flex items-center gap-2 mb-2 rounded-md bg-bg-surface px-3 py-1.5 text-sm text-error">
          <span>
            {unavailableReason === 'no-session'
              ? 'Session expired \u2014 log out and back in to restore encryption'
              : 'Waiting for encryption keys \u2014 another member needs to be online'}
          </span>
          {unavailableReason !== 'no-session' && (
            <button
              type="button"
              onClick={retryEncryption}
              className="underline"
            >
              Retry
            </button>
          )}
        </div>
      )}

      {/* Reply preview bar */}
      {replyingTo && (
        <div className="flex items-center gap-2 mb-2 rounded-md bg-bg-surface px-3 py-1.5 text-xs border-l-2 border-accent">
          <span className="text-text-muted flex-1 truncate">
            Replying to{' '}
            <span className="font-medium text-text">{replyAuthorName}</span>
            {replyPreviewText && (
              <span className="text-text-subtle ml-1">
                — {replyPreviewText}
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={cancelReply}
            className="text-text-muted hover:text-text flex-shrink-0"
            title="Cancel reply"
          >
            &#x2715;
          </button>
        </div>
      )}

      {/* Pending files preview strip */}
      {pendingFiles.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {pendingFiles.map((pf) => (
            <div
              key={pf.id}
              className="relative h-32 w-32 rounded-md border border-border bg-bg-elevated overflow-hidden [&:hover_.preview-overlay]:opacity-100 [&:hover_.spoiler-badge]:opacity-0"
            >
              {pf.preview ? (
                <img
                  src={pf.preview}
                  alt={pf.file.name}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <div className="text-center px-1">
                    <FileIcon
                      size={24}
                      className="mx-auto text-text-muted"
                      aria-hidden="true"
                    />
                    <p className="text-xs text-text-muted mt-1 truncate max-w-[112px]">
                      {pf.file.name}
                    </p>
                  </div>
                </div>
              )}

              <div className="preview-overlay absolute inset-0 z-10 flex opacity-0 transition-opacity duration-150">
                <button
                  type="button"
                  onClick={() => toggleSpoiler(pf.id)}
                  className="flex-1 flex items-center justify-center bg-black/50 text-white hover:bg-black/60 transition-colors"
                  title={pf.isSpoiler ? 'Remove spoiler' : 'Mark as spoiler'}
                >
                  {pf.isSpoiler ? (
                    <EyeIcon weight="bold" size={28} aria-hidden="true" />
                  ) : (
                    <EyeSlashIcon weight="bold" size={28} aria-hidden="true" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => removeFile(pf.id)}
                  className="flex-1 flex items-center justify-center bg-black/50 text-white hover:text-error hover:bg-black/60 transition-colors"
                  title="Remove"
                >
                  <XIcon weight="bold" size={28} aria-hidden="true" />
                </button>
              </div>

              {pf.isSpoiler && (
                <div className="spoiler-badge absolute inset-0 z-[5] flex items-center justify-center bg-black/70 pointer-events-none transition-opacity duration-150">
                  <EyeSlashIcon
                    weight="bold"
                    size={20}
                    className="text-white/60"
                    aria-hidden="true"
                  />
                </div>
              )}

              {sending && !pf.error && pf.progress < 100 && (
                <div className="absolute bottom-0 left-0 right-0 h-1 bg-border">
                  <div
                    className="h-full bg-accent transition-[width] duration-150"
                    style={{ width: `${pf.progress}%` }}
                  />
                </div>
              )}

              {pf.error && (
                <div className="absolute inset-0 flex items-center justify-center bg-error/20">
                  <span className="text-[10px] text-error font-medium">
                    Failed
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="relative">
        {/* GIF picker */}
        {gifPickerQuery !== null && (
          <GifPicker
            initialQuery={gifPickerQuery}
            onSelect={(gifUrl) => {
              setGifPickerQuery(null);
              handleSend(gifUrl);
            }}
            onClose={() => setGifPickerQuery(null)}
          />
        )}

        {/* Autocomplete popups */}
        {autocomplete.trigger === 'mention' && (
          <MentionAutocomplete
            query={autocomplete.query}
            serverId={resolvedServerId}
            onSelect={(item) => {
              if (item.type === 'everyone') {
                editorRef.current?.insertMention('', 'everyone');
              } else {
                editorRef.current?.insertMention(
                  item.id,
                  item.type as 'user' | 'role',
                );
              }
            }}
            onClose={() => editorRef.current?.focus()}
            position={{ bottom: 48, left: 0 }}
          />
        )}
        {autocomplete.trigger === 'channel' && (
          <ChannelAutocomplete
            query={autocomplete.query}
            serverId={resolvedServerId}
            onSelect={(item) => {
              editorRef.current?.insertChannelLink(item.id);
            }}
            onClose={() => editorRef.current?.focus()}
            position={{ bottom: 48, left: 0 }}
          />
        )}
        {autocomplete.trigger === 'emoji' && (
          <EmojiAutocomplete
            query={autocomplete.query}
            serverId={resolvedServerId}
            onSelect={(insertText) => {
              // EmojiAutocomplete returns wire format like <:name:id>
              // Parse it to extract name and id for the node
              const match = insertText.match(/^<(a?):([^:]+):([^>]+)>$/);
              if (match) {
                editorRef.current?.insertCustomEmoji(
                  match[3],
                  match[2],
                  match[1] === 'a',
                );
              } else {
                editorRef.current?.insertText(insertText);
              }
            }}
            onClose={() => editorRef.current?.focus()}
            position={{ bottom: 48, left: 0 }}
          />
        )}
        {autocomplete.trigger === 'slash' && (
          <SlashCommandAutocomplete
            query={autocomplete.query}
            onSelect={(cmd) => {
              editorRef.current?.clear();
              editorRef.current?.insertText(`/${cmd.name} `);
            }}
            onClose={() => editorRef.current?.focus()}
          />
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_TYPES}
          multiple
          className="hidden"
          onChange={handleFileChange}
        />

        <div className="flex min-h-[60px] rounded-lg border border-border/50 bg-bg-surface transition-colors">
          {/* Attachment button */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={
              sending ||
              disabled ||
              encryptionPending ||
              pendingFiles.length >= MAX_FILES
            }
            className="flex-shrink-0 self-start mt-5 ml-5 text-text-muted hover:text-text transition-colors disabled:opacity-50"
            title="Attach files"
          >
            <PaperclipIcon weight="regular" size={22} aria-hidden="true" />
          </button>

          {/* ProseMirror composer editor */}
          <div
            className="flex-1 overflow-y-auto"
            style={{ maxHeight: isMobile ? '80px' : '150px' }}
          >
            <Suspense
              fallback={
                <div className="px-3 py-4 text-text-subtle">
                  {placeholderText}
                </div>
              }
            >
              <ProsemirrorAdapterProvider>
                <ComposerEditor
                  ref={editorRef}
                  channelId={channelId}
                  onSend={handleEditorSend}
                  onCancel={handleCancel}
                  onTyping={handleTyping}
                  placeholder={placeholderText}
                  autoFocus={!isMobile}
                  onAutocompleteChange={setAutocomplete}
                />
              </ProsemirrorAdapterProvider>
            </Suspense>
          </div>

          <EmojiPickerButton
            onSelect={(emoji) => editorRef.current?.insertText(emoji)}
            onClose={() => editorRef.current?.focus()}
            disabled={sending || disabled}
            serverId={serverId}
            mobileEmojiOpen={mobileEmojiOpen}
            onMobileToggle={onMobileEmojiToggle}
          />

          {/* Mobile send button */}
          {isMobile && (
            <button
              type="button"
              onClick={() => editorRef.current?.send()}
              disabled={sending || disabled}
              className="flex-shrink-0 self-start mt-5 mr-5 text-accent disabled:text-text-subtle transition-colors"
              aria-label="Send message"
            >
              <PaperPlaneRightIcon size={22} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
