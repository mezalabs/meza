import { createServer, getMediaURL, UploadPurpose } from '@meza/core';
import * as Dialog from '@radix-ui/react-dialog';
import { type FormEvent, useEffect, useState } from 'react';
import { useImageCropUpload } from '../../hooks/useImageCropUpload.ts';
import { useNavigationStore } from '../../stores/navigation.ts';
import { ImageCropper } from '../shared/ImageCropper.tsx';

export function CreateServerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState('');
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const iconUpload = useImageCropUpload({
    purpose: UploadPurpose.SERVER_ICON,
    aspectRatio: 1,
    cropShape: 'rect',
    onUploadComplete: (url) => {
      setIconUrl(url);
      const attachmentId = url.replace('/media/', '');
      setPreviewUrl(getMediaURL(attachmentId, true));
    },
  });

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setName('');
      setIconUrl(null);
      setPreviewUrl(null);
      setError(null);
      setLoading(false);
    }
  }, [open]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    setLoading(true);
    setError(null);
    try {
      const server = await createServer(trimmed, iconUrl ?? undefined);
      if (server) {
        useNavigationStore.getState().selectServer(server.id);
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create server');
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
              Create a Server
            </Dialog.Title>

            <form onSubmit={handleSubmit} className="mt-4 space-y-4">
              {/* Icon upload */}
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
                      alt="Server icon"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span className="text-xl text-text-muted group-hover:text-accent">
                      +
                    </span>
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
                      setIconUrl(null);
                    }}
                    className="text-xs text-text-muted hover:text-text"
                  >
                    Remove icon
                  </button>
                ) : (
                  <span className="text-xs text-text-muted">
                    Upload an icon
                  </span>
                )}
              </div>

              <div>
                <label
                  htmlFor="server-name"
                  className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-text-subtle"
                >
                  Server Name
                </label>
                <input
                  id="server-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My Awesome Server"
                  maxLength={100}
                  required
                  disabled={loading}
                  className="w-full border border-border bg-bg-surface text-text placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-50"
                />
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
                    loading || !name.trim() || iconUpload.state !== 'idle'
                  }
                  className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-50"
                >
                  {loading ? 'Creating...' : 'Create'}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {iconUpload.cropperProps && (
        <ImageCropper
          {...iconUpload.cropperProps}
          onOpenChange={(open) => {
            if (!open) iconUpload.cropperProps?.onCancel();
          }}
        />
      )}
    </>
  );
}
