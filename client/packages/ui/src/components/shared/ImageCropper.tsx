import * as Dialog from '@radix-ui/react-dialog';
import Cropper from 'react-easy-crop';
import { useCallback, useState } from 'react';
import { getCroppedImage, type PixelCrop } from '../../utils/image-utils.ts';

export interface ImageCropperProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  imageSrc: string;
  aspectRatio: number;
  cropShape: 'round' | 'rect';
  onCrop: (croppedFile: File) => void;
  onCancel: () => void;
}

export function ImageCropper({
  open,
  onOpenChange,
  imageSrc,
  aspectRatio,
  cropShape,
  onCrop,
  onCancel,
}: ImageCropperProps) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<PixelCrop | null>(
    null,
  );

  const onCropComplete = useCallback(
    (_croppedArea: unknown, croppedPixels: PixelCrop) => {
      setCroppedAreaPixels(croppedPixels);
    },
    [],
  );

  const [cropError, setCropError] = useState<string | null>(null);

  const handleCrop = useCallback(async () => {
    if (!croppedAreaPixels) return;

    try {
      setCropError(null);
      const file = await getCroppedImage(imageSrc, croppedAreaPixels, 'crop.jpg');
      onCrop(file);
    } catch {
      setCropError('Failed to crop image. Please try again.');
    }
  }, [imageSrc, croppedAreaPixels, onCrop]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 animate-fade-in" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg bg-bg-elevated p-6 shadow-lg animate-scale-in">
          <Dialog.Title className="text-lg font-semibold text-text">
            Crop Image
          </Dialog.Title>

          {/* Cropper area */}
          <div
            className="relative mt-4 h-[300px]"
            role="application"
            aria-roledescription="image cropper"
          >
            <Cropper
              image={imageSrc}
              crop={crop}
              zoom={zoom}
              aspect={aspectRatio}
              cropShape={cropShape}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={onCropComplete}
              minZoom={1}
              maxZoom={5}
              showGrid={true}
            />
          </div>

          {/* Zoom controls */}
          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              aria-label="Zoom out"
              onClick={() => setZoom((z) => Math.max(1, z - 0.1))}
              className="flex h-8 w-8 items-center justify-center rounded-md bg-bg-surface text-text-muted hover:text-text"
            >
              −
            </button>
            <input
              type="range"
              aria-label="Zoom"
              min={1}
              max={5}
              step={0.1}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              className="flex-1"
            />
            <button
              type="button"
              aria-label="Zoom in"
              onClick={() => setZoom((z) => Math.min(5, z + 0.1))}
              className="flex h-8 w-8 items-center justify-center rounded-md bg-bg-surface text-text-muted hover:text-text"
            >
              +
            </button>
          </div>

          {cropError && (
            <p className="mt-2 text-xs text-error">{cropError}</p>
          )}

          {/* Action buttons */}
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md bg-bg-surface px-3 py-1.5 text-sm text-text-muted hover:bg-bg-elevated hover:text-text"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleCrop}
              disabled={!croppedAreaPixels}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-50"
            >
              Crop
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
