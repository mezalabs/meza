import {
  getMediaURL,
  UploadPurpose,
  updateServer,
  useServerStore,
} from '@meza/core';
import { useCallback, useState } from 'react';
import { useImageCropUpload } from '../../hooks/useImageCropUpload.ts';
import { ImageCropper } from '../shared/ImageCropper.tsx';

interface OverviewSectionProps {
  serverId: string;
}

export function OverviewSection({ serverId }: OverviewSectionProps) {
  const server = useServerStore((s) => s.servers[serverId]);
  const [name, setName] = useState(server?.name ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDirty = name.trim() !== (server?.name ?? '');

  const iconUpload = useImageCropUpload({
    purpose: UploadPurpose.SERVER_ICON,
    aspectRatio: 1,
    cropShape: 'rect',
    onUploadComplete: async (url) => {
      await updateServer(serverId, { iconUrl: url });
    },
  });

  const handleSave = useCallback(async () => {
    if (saving || !isDirty) return;
    setSaving(true);
    setError(null);
    try {
      await updateServer(serverId, { name: name.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [saving, isDirty, serverId, name]);

  const handleDiscard = useCallback(() => {
    setName(server?.name ?? '');
    setError(null);
  }, [server?.name]);

  if (!server) return null;

  // Get the icon display URL
  const iconSrc = server.iconUrl
    ? (() => {
        const match = server.iconUrl.match(/^\/media\/([^/?]+)/);
        return match ? getMediaURL(match[1], true) : undefined;
      })()
    : undefined;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wider text-text-subtle mb-4">
          Server Overview
        </h3>

        {/* Server icon */}
        <div className="flex items-center gap-4 mb-6">
          <button
            type="button"
            onClick={() => iconUpload.openFileDialog()}
            disabled={iconUpload.state !== 'idle'}
            className="group relative flex h-20 w-20 flex-shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-bg-surface transition-colors hover:ring-2 hover:ring-accent"
          >
            {iconSrc ? (
              <img
                src={iconSrc}
                alt="Server icon"
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="text-2xl font-semibold text-text-muted">
                {server.name.charAt(0).toUpperCase()}
              </span>
            )}
            <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity rounded-[10px]">
              <span className="text-xs font-medium text-white">Change</span>
            </div>
            {iconUpload.uploadProgress !== null && (
              <div className="absolute inset-0 flex items-center justify-center bg-bg-base/80 rounded-[10px]">
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
            className="hidden"
            onChange={iconUpload.onFileChange}
          />
          <div className="text-sm text-text-muted">
            Click the icon to upload a new image.
          </div>
        </div>

        {/* Server name */}
        <div className="space-y-1">
          <label
            htmlFor="server-overview-name"
            className="block text-sm font-medium text-text"
          >
            Server Name
          </label>
          <input
            id="server-overview-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            className="w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
          />
          <p className="text-xs text-text-subtle">{name.trim().length}/100</p>
        </div>
      </div>

      {/* Errors */}
      {(error || iconUpload.error) && (
        <p className="text-sm text-error">{error || iconUpload.error}</p>
      )}

      {/* Actions */}
      {isDirty && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-50"
            disabled={saving}
            onClick={handleSave}
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
          <button
            type="button"
            className="rounded-md bg-bg-surface px-3 py-1.5 text-sm text-text-muted hover:text-text"
            onClick={handleDiscard}
          >
            Discard
          </button>
        </div>
      )}

      {/* Cropper dialog */}
      {iconUpload.cropperProps && (
        <ImageCropper
          {...iconUpload.cropperProps}
          onOpenChange={(open) => {
            if (!open) iconUpload.cropperProps?.onCancel();
          }}
        />
      )}
    </div>
  );
}
