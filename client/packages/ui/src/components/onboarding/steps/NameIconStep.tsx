import { UploadPurpose, uploadFile } from '@meza/core';
import { useCallback, useEffect, useRef, useState } from 'react';

const ACCEPTED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

interface NameIconStepProps {
  name: string;
  onNameChange: (name: string) => void;
  onIconUrlChange: (url: string | null) => void;
}

export function NameIconStep({
  name,
  onNameChange,
  onIconUrlChange,
}: NameIconStepProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Revoke blob URL on unmount or when replaced
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

      if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
        setError('Unsupported format. Use JPEG, PNG, GIF, or WebP.');
        return;
      }

      // Show local preview immediately
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(file));

      setUploadProgress(0);
      try {
        const result = await uploadFile(
          file,
          UploadPurpose.SERVER_ICON,
          setUploadProgress,
        );
        onIconUrlChange(`/media/${result.attachmentId}`);
      } catch (err) {
        setError('Failed to upload icon');
        setPreviewUrl(null);
      } finally {
        setUploadProgress(null);
      }
    },
    [onIconUrlChange, previewUrl],
  );

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-lg font-semibold text-text">Name your server</h2>
        <p className="mt-1 text-sm text-text-muted">
          Give your server a name and an optional icon.
        </p>
      </div>

      {/* Icon upload */}
      <div className="flex flex-col items-center gap-3">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadProgress !== null}
          className="group relative flex h-20 w-20 items-center justify-center overflow-hidden rounded-full border-2 border-dashed border-border bg-bg-surface transition-colors hover:border-accent"
        >
          {previewUrl ? (
            <img
              src={previewUrl}
              alt="Server icon"
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="text-2xl text-text-muted group-hover:text-accent">
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
          accept="image/jpeg,image/png,image/gif,image/webp"
          onChange={handleFileSelect}
          className="hidden"
        />
        {previewUrl && (
          <button
            type="button"
            onClick={() => {
              if (previewUrl) URL.revokeObjectURL(previewUrl);
              setPreviewUrl(null);
              onIconUrlChange(null);
            }}
            className="text-xs text-text-muted hover:text-text"
          >
            Remove icon
          </button>
        )}
        {error && <p className="text-xs text-error">{error}</p>}
      </div>

      {/* Server name */}
      <div>
        <label
          htmlFor="server-name"
          className="mb-1 block text-sm font-medium text-text"
        >
          Server name
        </label>
        <input
          id="server-name"
          type="text"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          maxLength={100}
          className="w-full border border-border bg-bg-base text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
      </div>
    </div>
  );
}
