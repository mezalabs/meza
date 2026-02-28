import {
  createEmoji,
  deleteEmoji,
  getMediaURL,
  listEmojis,
  listUserEmojis,
  UploadPurpose,
  updateEmoji,
  uploadFile,
  useAuthStore,
  useEmojiStore,
} from '@meza/core';
import { useEffect, useRef, useState } from 'react';

const EMPTY_EMOJIS: never[] = [];
const MAX_SERVER_EMOJIS = 20;
const MAX_PERSONAL_EMOJIS = 10;
const NAME_REGEX = /^[a-z0-9_]{2,32}$/;

interface EmojisSectionProps {
  serverId?: string;
}

export function EmojisSection({ serverId }: EmojisSectionProps) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const emojis = useEmojiStore((s) =>
    serverId ? (s.byServer[serverId] ?? EMPTY_EMOJIS) : s.personal,
  );
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editError, setEditError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const maxEmojis = serverId ? MAX_SERVER_EMOJIS : MAX_PERSONAL_EMOJIS;
  const label = serverId ? 'Custom Emojis' : 'My Emojis';

  useEffect(() => {
    if (!isAuthenticated) return;
    if (serverId) {
      listEmojis(serverId).catch(() => {});
    } else {
      listUserEmojis().catch(() => {});
    }
  }, [serverId, isAuthenticated]);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset input
    if (fileInputRef.current) fileInputRef.current.value = '';

    // Derive name from filename
    const baseName = file.name
      .replace(/\.[^.]+$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .slice(0, 32);
    if (!NAME_REGEX.test(baseName)) {
      setUploadError(
        'Invalid emoji name. Use 2-32 lowercase letters, numbers, or underscores.',
      );
      return;
    }

    setUploadError('');
    setIsUploading(true);
    try {
      const { attachmentId } = await uploadFile(
        file,
        UploadPurpose.SERVER_EMOJI,
      );
      await createEmoji(baseName, attachmentId, serverId);
    } catch {
      setUploadError('Failed to upload emoji');
    } finally {
      setIsUploading(false);
    }
  }

  async function handleDelete(emojiId: string) {
    setIsDeleting(true);
    try {
      await deleteEmoji(emojiId);
      useEmojiStore.getState().removeEmoji(serverId ?? '', emojiId);
      setDeleteConfirmId(null);
    } catch {
      // Error handled
    } finally {
      setIsDeleting(false);
    }
  }

  async function handleRename(emojiId: string) {
    const trimmed = editName.trim();
    if (!NAME_REGEX.test(trimmed)) {
      setEditError(
        'Name must be 2-32 lowercase letters, numbers, or underscores.',
      );
      return;
    }
    setEditError('');
    try {
      await updateEmoji(emojiId, trimmed);
      setEditingId(null);
    } catch {
      setEditError('Failed to rename emoji');
    }
  }

  const atLimit = emojis.length >= maxEmojis;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text">{label}</h2>
          <p className="text-sm text-text-muted">
            {emojis.length}/{maxEmojis} emojis used
          </p>
        </div>
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="hidden"
            onChange={handleUpload}
            disabled={isUploading || atLimit}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading || atLimit}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-black hover:bg-accent/80 disabled:opacity-50"
          >
            {isUploading ? 'Uploading...' : 'Upload Emoji'}
          </button>
        </div>
      </div>

      {uploadError && <p className="mb-3 text-xs text-error">{uploadError}</p>}

      {emojis.length === 0 && (
        <p className="text-sm text-text-muted">
          No {serverId ? 'custom' : 'personal'} emojis yet. Upload one to get
          started!
        </p>
      )}

      <div className="flex flex-col gap-2">
        {emojis.map((emoji) => {
          const attachmentId = emoji.imageUrl.replace('/media/', '');
          return (
            <div
              key={emoji.id}
              className="flex items-center justify-between rounded-lg border border-border bg-bg-surface p-3"
            >
              <div className="flex items-center gap-3">
                <img
                  src={getMediaURL(attachmentId)}
                  alt={`:${emoji.name}:`}
                  className="h-8 w-8 rounded object-contain"
                  loading="lazy"
                />
                {editingId === emoji.id ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="w-40 rounded-md border border-border bg-bg-surface px-2 py-1 text-sm text-text focus:border-accent focus:outline-none"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRename(emoji.id);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => handleRename(emoji.id)}
                      className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-black hover:bg-accent/80"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="rounded-md px-2 py-1 text-xs text-text-muted hover:text-text"
                    >
                      Cancel
                    </button>
                    {editError && (
                      <span className="text-xs text-error">{editError}</span>
                    )}
                  </div>
                ) : (
                  <span className="text-sm font-medium text-text">
                    :{emoji.name}:
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {editingId !== emoji.id && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(emoji.id);
                      setEditName(emoji.name);
                      setEditError('');
                    }}
                    className="rounded-md px-2 py-1 text-sm text-text-muted hover:bg-bg-elevated hover:text-text"
                  >
                    Rename
                  </button>
                )}
                {deleteConfirmId === emoji.id ? (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={isDeleting}
                      onClick={() => handleDelete(emoji.id)}
                      className="rounded-md bg-error px-2 py-1 text-sm font-medium text-white hover:bg-error/80 disabled:opacity-50"
                    >
                      {isDeleting ? 'Deleting...' : 'Confirm'}
                    </button>
                    <button
                      type="button"
                      disabled={isDeleting}
                      onClick={() => setDeleteConfirmId(null)}
                      className="rounded-md px-2 py-1 text-sm text-text-muted hover:text-text"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setDeleteConfirmId(emoji.id)}
                    className="rounded-md px-2 py-1 text-sm text-error hover:bg-error/10"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
