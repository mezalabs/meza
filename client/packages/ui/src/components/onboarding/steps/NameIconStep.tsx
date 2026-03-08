import { UploadPurpose, getMediaURL } from '@meza/core';
import { useEffect, useState } from 'react';
import { ImageCropper } from '../../shared/ImageCropper.tsx';
import { useImageCropUpload } from '../../../hooks/useImageCropUpload.ts';

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
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const iconUpload = useImageCropUpload({
    purpose: UploadPurpose.SERVER_ICON,
    aspectRatio: 1,
    cropShape: 'rect',
    onUploadComplete: (url) => {
      onIconUrlChange(url);
      const attachmentId = url.replace('/media/', '');
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(getMediaURL(attachmentId, true));
    },
  });

  // Revoke blob URL on unmount or when replaced
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

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
          onClick={() => iconUpload.openFileDialog()}
          disabled={iconUpload.state !== 'idle'}
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
        {iconUpload.error && (
          <p className="text-xs text-error">{iconUpload.error}</p>
        )}
      </div>

      {iconUpload.cropperProps && (
        <ImageCropper
          {...iconUpload.cropperProps}
          onOpenChange={(open) => {
            if (!open) iconUpload.cropperProps?.onCancel();
          }}
        />
      )}

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
