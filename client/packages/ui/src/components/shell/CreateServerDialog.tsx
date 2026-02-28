import { createServer, UploadPurpose, uploadFile } from '@meza/core';
import * as Dialog from '@radix-ui/react-dialog';
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useNavigationStore } from '../../stores/navigation.ts';

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
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setName('');
      setIconUrl(null);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      setUploadProgress(null);
      setError(null);
      setLoading(false);
    }
  }, [open, previewUrl]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setError(null);

      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(file));

      setUploadProgress(0);
      try {
        const result = await uploadFile(
          file,
          UploadPurpose.SERVER_ICON,
          setUploadProgress,
        );
        setIconUrl(`/media/${result.attachmentId}`);
      } catch {
        setError('Failed to upload icon');
        setPreviewUrl(null);
        setIconUrl(null);
      } finally {
        setUploadProgress(null);
      }
    },
    [previewUrl],
  );

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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 animate-fade-in" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg bg-bg-elevated p-6 shadow-lg animate-scale-in">
          <Dialog.Title className="text-lg font-semibold text-text">
            Create a Server
          </Dialog.Title>

          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            {/* Icon upload */}
            <div className="flex flex-col items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadProgress !== null || loading}
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
                {uploadProgress !== null && (
                  <div className="absolute inset-0 flex items-center justify-center bg-bg-base/80">
                    <span className="text-xs text-text-muted">
                      {Math.round(uploadProgress * 100)}%
                    </span>
                  </div>
                )}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileSelect}
                className="hidden"
              />
              {previewUrl ? (
                <button
                  type="button"
                  onClick={() => {
                    if (previewUrl) URL.revokeObjectURL(previewUrl);
                    setPreviewUrl(null);
                    setIconUrl(null);
                  }}
                  className="text-xs text-text-muted hover:text-text"
                >
                  Remove icon
                </button>
              ) : (
                <span className="text-xs text-text-muted">Upload an icon</span>
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

            {error && <p className="text-xs text-error">{error}</p>}

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
                disabled={loading || !name.trim() || uploadProgress !== null}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-50"
              >
                {loading ? 'Creating...' : 'Create'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
