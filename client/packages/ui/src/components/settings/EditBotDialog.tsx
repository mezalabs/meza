import { useBotStore, getMediaURL, UploadPurpose } from '@meza/core';
import type { Bot } from '@meza/core';
import * as Dialog from '@radix-ui/react-dialog';
import { type FormEvent, useEffect, useState } from 'react';
import { useImageCropUpload } from '../../hooks/useImageCropUpload.ts';
import { Avatar } from '../shared/Avatar.tsx';
import { ImageCropper } from '../shared/ImageCropper.tsx';

interface EditBotDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bot: Bot;
}

export function EditBotDialog({ open, onOpenChange, bot }: EditBotDialogProps) {
  const [displayName, setDisplayName] = useState(bot.displayName);
  const [description, setDescription] = useState(bot.description);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(
    bot.avatarUrl || null,
  );
  const [previewUrl, setPreviewUrl] = useState<string | null>(
    bot.avatarUrl ? getMediaURL(bot.avatarUrl.replace('/media/', ''), true) : null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateBot = useBotStore((s) => s.updateBot);

  const iconUpload = useImageCropUpload({
    purpose: UploadPurpose.SERVER_ICON,
    aspectRatio: 1,
    cropShape: 'rect',
    onUploadComplete: (url) => {
      setAvatarUrl(url);
      const attachmentId = url.replace('/media/', '');
      setPreviewUrl(getMediaURL(attachmentId, true));
    },
  });

  useEffect(() => {
    if (open) {
      setDisplayName(bot.displayName);
      setDescription(bot.description);
      setAvatarUrl(bot.avatarUrl || null);
      setPreviewUrl(
        bot.avatarUrl
          ? getMediaURL(bot.avatarUrl.replace('/media/', ''), true)
          : null,
      );
      setError(null);
      setLoading(false);
    }
  }, [open, bot]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedName = displayName.trim();
    if (!trimmedName) return;

    // Only send changed fields
    const fields: {
      displayName?: string;
      description?: string;
      avatarUrl?: string;
    } = {};

    if (trimmedName !== bot.displayName) {
      fields.displayName = trimmedName;
    }
    if (description.trim() !== bot.description) {
      fields.description = description.trim();
    }
    if (avatarUrl !== (bot.avatarUrl || null)) {
      fields.avatarUrl = avatarUrl ?? '';
    }

    if (Object.keys(fields).length === 0) {
      onOpenChange(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await updateBot(bot.id, fields);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update bot');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 animate-fade-in" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg bg-bg-elevated p-6 shadow-lg animate-scale-in">
            <Dialog.Title className="text-lg font-semibold text-text">
              Edit Bot
            </Dialog.Title>

            <form onSubmit={handleSubmit} className="mt-4 space-y-4">
              {/* Avatar upload */}
              <div className="flex flex-col items-center gap-2">
                <button
                  type="button"
                  onClick={() => iconUpload.openFileDialog()}
                  disabled={iconUpload.state !== 'idle' || loading}
                  className="group relative flex h-16 w-16 items-center justify-center overflow-hidden rounded-full border-2 border-dashed border-border bg-bg-surface transition-colors hover:border-accent"
                >
                  {previewUrl ? (
                    <img
                      src={previewUrl}
                      alt="Bot avatar"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <Avatar
                      displayName={displayName || bot.username}
                      size="xl"
                    />
                  )}
                  {iconUpload.uploadProgress !== null && (
                    <div className="absolute inset-0 flex items-center justify-center bg-bg-base/80">
                      <span className="text-xs text-text-muted">
                        {iconUpload.uploadProgress}%
                      </span>
                    </div>
                  )}
                </button>
                <input
                  ref={iconUpload.fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  onChange={iconUpload.onFileChange}
                  className="hidden"
                />
                {previewUrl ? (
                  <button
                    type="button"
                    onClick={() => {
                      setPreviewUrl(null);
                      setAvatarUrl(null);
                    }}
                    className="text-xs text-text-muted hover:text-text"
                  >
                    Remove avatar
                  </button>
                ) : (
                  <span className="text-xs text-text-muted">
                    Upload an avatar
                  </span>
                )}
              </div>

              <div>
                <label
                  htmlFor="edit-bot-display-name"
                  className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-text-subtle"
                >
                  Display Name
                </label>
                <input
                  id="edit-bot-display-name"
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Bot Display Name"
                  maxLength={100}
                  required
                  disabled={loading}
                  className="w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-50"
                />
              </div>

              <div>
                <label
                  htmlFor="edit-bot-description"
                  className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-text-subtle"
                >
                  Description
                </label>
                <textarea
                  id="edit-bot-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What does this bot do?"
                  maxLength={256}
                  rows={3}
                  disabled={loading}
                  className="w-full resize-none rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-50"
                />
                <span className="text-xs text-text-subtle">
                  {description.length}/256
                </span>
              </div>

              {(error || iconUpload.error) && (
                <p className="text-xs text-error">
                  {error || iconUpload.error}
                </p>
              )}

              <div className="flex justify-end gap-2">
                <Dialog.Close asChild>
                  <button
                    type="button"
                    disabled={loading}
                    className="rounded-md bg-bg-surface px-3 py-1.5 text-sm text-text-muted hover:bg-bg-elevated hover:text-text"
                  >
                    Cancel
                  </button>
                </Dialog.Close>
                <button
                  type="submit"
                  disabled={
                    loading ||
                    !displayName.trim() ||
                    iconUpload.state !== 'idle'
                  }
                  className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-50"
                >
                  {loading ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {iconUpload.cropperProps && (
        <ImageCropper
          {...iconUpload.cropperProps}
          onOpenChange={(isOpen) => {
            if (!isOpen) iconUpload.cropperProps?.onCancel();
          }}
        />
      )}
    </>
  );
}
