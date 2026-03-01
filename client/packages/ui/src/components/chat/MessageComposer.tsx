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
import { FileIcon, PaperclipIcon, XIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { getCommand } from '../../commands/index.ts';
import { useChannelEncryption } from '../../hooks/useChannelEncryption.ts';
import { useDisplayName } from '../../hooks/useDisplayName.ts';
import { stripMarkdown } from '../shared/stripMarkdown.ts';
import { EmojiAutocomplete } from './EmojiAutocomplete.tsx';
import { EmojiPickerButton } from './EmojiPickerButton.tsx';
import { GifPicker } from './GifPicker.tsx';
import { MentionAutocomplete } from './MentionAutocomplete.tsx';
import { SlashCommandAutocomplete } from './SlashCommandAutocomplete.tsx';

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
}

interface MessageComposerProps {
  channelId: string;
  serverId?: string;
  disabled?: boolean;
}

export function MessageComposer({
  channelId,
  serverId,
  disabled,
}: MessageComposerProps) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionTriggerPos, setMentionTriggerPos] = useState(0);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [emojiQuery, setEmojiQuery] = useState<string | null>(null);
  const [emojiTriggerPos, setEmojiTriggerPos] = useState(0);
  const [gifPickerQuery, setGifPickerQuery] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cursorPositionRef = useRef<number>(0);
  // Use channelToServer to determine if this is a server channel regardless of
  // whether the serverId prop has been resolved yet (avoids race on page reload).
  const resolvedServerId = useChannelStore(
    (s) => serverId || s.channelToServer[channelId],
  );
  const _isDM = !resolvedServerId;
  const channel = useChannelStore((s) =>
    resolvedServerId
      ? s.byServer[resolvedServerId]?.find((c) => c.id === channelId)
      : undefined,
  );
  const channelName = channel?.name;
  const needsEncryption = true; // Universal E2EE: all channels encrypted
  const {
    encrypt,
    ready: encryptionReady,
    isEncrypted,
    retry: retryEncryption,
  } = useChannelEncryption(channelId);

  // Focus textarea on mount and channel switch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: channelId triggers re-focus on channel switch
  useEffect(() => {
    textareaRef.current?.focus();
  }, [channelId]);

  const replyingTo = useMessageStore((s) => s.replyingTo[channelId] ?? null);
  const replyAuthorName = useDisplayName(replyingTo?.authorId ?? '', serverId);

  // Keep cursor position fresh on every selection change and blur
  function handleSelect() {
    cursorPositionRef.current = textareaRef.current?.selectionStart ?? 0;
  }

  // Stable ref -- uses functional setDraft updater so no draft dependency
  const insertEmoji = useCallback((native: string) => {
    const pos = cursorPositionRef.current;
    const newPos = pos + native.length;

    flushSync(() => {
      setDraft((prev) => prev.slice(0, pos) + native + prev.slice(pos));
    });

    // DOM is committed after flushSync -- safe to touch textarea
    cursorPositionRef.current = newPos;
    textareaRef.current?.setSelectionRange(newPos, newPos);
    textareaRef.current?.focus();
  }, []);

  const focusTextarea = useCallback(() => {
    textareaRef.current?.focus();
  }, []);

  // Re-grab focus when clicking non-interactive areas (e.g. message list).
  const handleBlur = useCallback(() => {
    requestAnimationFrame(() => {
      const active = document.activeElement;
      const isInteractive =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLButtonElement ||
        active instanceof HTMLSelectElement ||
        active?.closest(
          '[role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]',
        );
      if (!isInteractive) {
        textareaRef.current?.focus();
      }
    });
  }, []);

  // Revoke any outstanding object URLs when the component unmounts to prevent memory leaks.
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

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files);
    }
    // Reset so the same file can be re-selected
    e.target.value = '';
  }

  function cancelReply() {
    useMessageStore.getState().setReplyingTo(channelId, null);
  }

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

  function detectMentionTrigger(text: string, cursorPos: number) {
    // Look backward from cursor for an unmatched @.
    const before = text.slice(0, cursorPos);
    const atIndex = before.lastIndexOf('@');
    if (atIndex === -1) {
      setMentionQuery(null);
      return;
    }
    // The @ must be at the start or preceded by whitespace.
    if (atIndex > 0 && !/\s/.test(before[atIndex - 1])) {
      setMentionQuery(null);
      return;
    }
    const query = before.slice(atIndex + 1);
    // Close if the query contains whitespace (except for @everyone which has no space).
    if (query.includes(' ') && !query.startsWith('everyone')) {
      setMentionQuery(null);
      return;
    }
    setMentionQuery(query);
    setMentionTriggerPos(atIndex);
  }

  function detectSlashTrigger(text: string, cursorPos: number) {
    if (!text.startsWith('/')) {
      setSlashQuery(null);
      return;
    }
    // Close popup once the user has typed past the command name (space present).
    const spaceIndex = text.indexOf(' ');
    if (spaceIndex !== -1 && cursorPos > spaceIndex) {
      setSlashQuery(null);
      return;
    }
    setSlashQuery(text.slice(1, cursorPos));
  }

  function detectEmojiTrigger(text: string, cursorPos: number) {
    const before = text.slice(0, cursorPos);
    // Find the last unmatched `:` — skip if preceded by `<` (existing emoji ref).
    const colonIndex = before.lastIndexOf(':');
    if (colonIndex === -1) {
      setEmojiQuery(null);
      return;
    }
    // Don't trigger inside an existing emoji ref like `<:name:ID>`
    if (colonIndex > 0 && before[colonIndex - 1] === '<') {
      setEmojiQuery(null);
      return;
    }
    // Also skip if there's an `<a` or `<` right before (animated emoji refs)
    const ltIndex = before.lastIndexOf('<', colonIndex);
    if (ltIndex !== -1 && before.indexOf('>', ltIndex) === -1) {
      // We're inside an unclosed `<...` tag — likely an emoji/mention ref
      setEmojiQuery(null);
      return;
    }
    const query = before.slice(colonIndex + 1);
    // Need at least 1 char to trigger, and no spaces allowed
    if (query.length === 0 || query.includes(' ')) {
      setEmojiQuery(null);
      return;
    }
    setEmojiQuery(query);
    setEmojiTriggerPos(colonIndex);
  }

  async function handleSend(overrideText?: string) {
    let text = (overrideText ?? draft).trim();

    // Intercept slash commands before the normal send flow.
    if (text.startsWith('/')) {
      const match = text.match(/^\/(\S+)\s*(.*)/);
      if (match) {
        const [, commandName, args] = match;
        const command = getCommand(commandName);
        if (command) {
          if (commandName === 'gif') {
            setGifPickerQuery(args || '');
            setDraft('');
            setSlashQuery(null);
            return;
          }
          if (command.silent) {
            command.execute(args, {
              channelId,
              serverId,
              sendMessage: () => {},
            });
            setDraft('');
            setSlashQuery(null);
            return;
          }
          // Non-silent: capture the transformed text and fall through
          // to the normal send flow (which handles encryption).
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
            setSlashQuery(null);
          } else {
            setDraft('');
            setSlashQuery(null);
            return;
          }
        }
      }
      // No command matched — fall through and send as a regular message.
    }

    const hasFiles = pendingFiles.length > 0;
    if ((!text && !hasFiles) || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);

    try {
      // Upload files sequentially (memory: 2x file size per concurrent encrypted upload)
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

      // Build V1 JSON content with attachment metadata
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
      // Universal E2EE: always encrypt, never send plaintext
      const encrypted = await encrypt(plaintext);
      if (!encrypted) {
        // Encryption not ready or failed — block sending
        return;
      }
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

      // Clean up previews
      for (const pf of pendingFiles) {
        if (pf.preview) URL.revokeObjectURL(pf.preview);
      }

      setDraft('');
      setPendingFiles([]);
      // Reset textarea height after clearing
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
      // Clear reply state after successful send
      if (replyingTo) {
        useMessageStore.getState().setReplyingTo(channelId, null);
      }
    } catch {
      // Error set in store
    } finally {
      sendingRef.current = false;
      flushSync(() => setSending(false));
      textareaRef.current?.focus();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // If a capture-phase handler (e.g. MentionAutocomplete) already handled
    // this event, don't process it again — prevents race conditions where
    // the useEffect-based document listener and this handler both fire.
    if (e.nativeEvent.defaultPrevented) return;

    // Let MentionAutocomplete handle keys when open.
    if (mentionQuery !== null) {
      if (['ArrowUp', 'ArrowDown', 'Tab', 'Enter', 'Escape'].includes(e.key)) {
        return; // Handled by the document-level listener in MentionAutocomplete.
      }
    }
    // Let SlashCommandAutocomplete handle keys when open.
    if (slashQuery !== null) {
      if (['ArrowUp', 'ArrowDown', 'Tab', 'Enter', 'Escape'].includes(e.key)) {
        return; // Handled by the document-level listener in SlashCommandAutocomplete.
      }
    }
    // Let EmojiAutocomplete handle keys when open.
    if (emojiQuery !== null) {
      if (['ArrowUp', 'ArrowDown', 'Tab', 'Enter', 'Escape'].includes(e.key)) {
        return; // Handled by the document-level listener in EmojiAutocomplete.
      }
    }
    if (e.key === 'Escape' && replyingTo) {
      e.preventDefault();
      cancelReply();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleMentionSelect(item: {
    type: 'user' | 'role' | 'everyone';
    insertText: string;
  }) {
    // Replace @query with the mention syntax.
    const before = draft.slice(0, mentionTriggerPos);
    const after = draft.slice(cursorPositionRef.current);
    const newDraft = `${before}${item.insertText} ${after}`;
    setDraft(newDraft);
    setMentionQuery(null);

    // Set cursor position after the inserted text.
    const newPos = mentionTriggerPos + item.insertText.length + 1;
    cursorPositionRef.current = newPos;
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(newPos, newPos);
      textareaRef.current?.focus();
    });
  }

  function handleEmojiAutocompleteSelect(insertText: string) {
    // Replace :query with the emoji ref.
    const before = draft.slice(0, emojiTriggerPos);
    const after = draft.slice(cursorPositionRef.current);
    const newDraft = `${before}${insertText} ${after}`;
    setDraft(newDraft);
    setEmojiQuery(null);

    const newPos = emojiTriggerPos + insertText.length + 1;
    cursorPositionRef.current = newPos;
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(newPos, newPos);
      textareaRef.current?.focus();
    });
  }

  // Truncate reply preview text (strip markdown for clean display).
  // Use safeParseMessageText to handle V1 JSON format and avoid showing raw JSON.
  const replyPreviewText = replyingTo
    ? stripMarkdown(safeParseMessageText(replyingTo.encryptedContent)).slice(
        0,
        100,
      )
    : '';

  const encryptionPending = needsEncryption && !encryptionReady;
  const encryptionUnavailable =
    needsEncryption && encryptionReady && !isEncrypted;

  return (
    <div className="flex-shrink-0 px-2 pt-1 pb-2">
      {/* Encryption retry banner */}
      {encryptionUnavailable && (
        <div className="flex items-center gap-2 mb-2 rounded-md bg-bg-surface px-3 py-1.5 text-sm text-error">
          <span>Encryption unavailable</span>
          <button type="button" onClick={retryEncryption} className="underline">
            Retry
          </button>
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
              className="relative group rounded-md border border-border bg-bg-elevated overflow-hidden"
            >
              {/* Remove button */}
              <button
                type="button"
                onClick={() => removeFile(pf.id)}
                className="absolute top-0.5 right-0.5 z-10 rounded-full bg-bg-elevated/80 p-0.5 text-text-muted hover:text-error opacity-0 group-hover:opacity-100 transition-opacity"
                title="Remove"
              >
                <XIcon weight="regular" size={14} aria-hidden="true" />
              </button>

              {pf.preview ? (
                <img
                  src={pf.preview}
                  alt={pf.file.name}
                  className="h-16 w-16 object-cover"
                />
              ) : (
                <div className="flex h-16 w-16 items-center justify-center">
                  <div className="text-center px-1">
                    <FileIcon
                      size={16}
                      className="mx-auto text-text-muted"
                      aria-hidden="true"
                    />
                    <p className="text-[9px] text-text-muted mt-0.5 truncate max-w-[56px]">
                      {pf.file.name}
                    </p>
                  </div>
                </div>
              )}

              {/* Progress bar */}
              {sending && !pf.error && pf.progress < 100 && (
                <div className="absolute bottom-0 left-0 right-0 h-1 bg-border">
                  <div
                    className="h-full bg-accent transition-[width] duration-150"
                    style={{ width: `${pf.progress}%` }}
                  />
                </div>
              )}

              {/* Error indicator */}
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
        {/* Mention autocomplete popup */}
        {mentionQuery !== null && (
          <MentionAutocomplete
            query={mentionQuery}
            serverId={serverId}
            onSelect={handleMentionSelect}
            onClose={() => setMentionQuery(null)}
            position={{ bottom: 48, left: 0 }}
          />
        )}

        {/* Emoji autocomplete popup */}
        {emojiQuery !== null && (
          <EmojiAutocomplete
            query={emojiQuery}
            serverId={serverId}
            onSelect={handleEmojiAutocompleteSelect}
            onClose={() => setEmojiQuery(null)}
            position={{ bottom: 48, left: 0 }}
          />
        )}

        {/* Slash command autocomplete popup */}
        {slashQuery !== null && !disabled && (
          <SlashCommandAutocomplete
            query={slashQuery}
            onSelect={(cmd) => {
              if (cmd.args?.length) {
                setDraft(`/${cmd.name} `);
                setSlashQuery(null);
                textareaRef.current?.focus();
              } else {
                // Let handleSend process the command so the message
                // goes through the normal send flow (encryption, etc.).
                setSlashQuery(null);
                handleSend(`/${cmd.name}`);
              }
            }}
            onClose={() => setSlashQuery(null)}
          />
        )}

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

          <textarea
            ref={textareaRef}
            className="flex-1 resize-none rounded-none border-none bg-transparent text-text focus:outline-none overflow-y-auto"
            style={{ maxHeight: '150px' }}
            placeholder={
              encryptionPending
                ? 'Setting up encryption…'
                : encryptionUnavailable
                  ? 'Encryption unavailable'
                  : replyingTo
                    ? 'Type a reply…'
                    : channelName
                      ? `Message #${channelName}`
                      : 'Type a message…'
            }
            rows={1}
            maxLength={4000}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              gatewaySendTyping(channelId);
              detectMentionTrigger(
                e.target.value,
                e.target.selectionStart ?? 0,
              );
              detectSlashTrigger(e.target.value, e.target.selectionStart ?? 0);
              detectEmojiTrigger(e.target.value, e.target.selectionStart ?? 0);
              // Auto-grow textarea
              e.target.style.height = 'auto';
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            onSelect={handleSelect}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            disabled={sending || disabled}
          />

          <EmojiPickerButton
            onSelect={insertEmoji}
            onClose={focusTextarea}
            disabled={sending || disabled}
            serverId={serverId}
          />
        </div>
      </div>
    </div>
  );
}
