import type { Attachment } from '@meza/core';
import {
  acquireBlobURL,
  decryptFile,
  fetchEncryptedMedia,
  getMediaURL,
  releaseBlobURL,
  unwrapFileKey,
} from '@meza/core';
import { CaretLeftIcon, CaretRightIcon, XIcon } from '@phosphor-icons/react';
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';
import { useImageViewerStore } from '../../stores/imageViewer.ts';

/** Check if an attachment is encrypted (has a wrapped file key). */
function isEncrypted(attachment: Attachment): boolean {
  return attachment.encryptedKey.length > 0;
}

function ViewerImage({ attachment }: { attachment: Attachment }) {
  const [loaded, setLoaded] = useState(false);
  const thumbSrc = getMediaURL(attachment.id, attachment.hasThumbnail);
  const fullSrc = getMediaURL(attachment.id);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation wrapper, not interactive
    <div
      className="relative flex items-center justify-center"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      role="presentation"
    >
      <img
        src={loaded ? fullSrc : thumbSrc}
        alt={attachment.filename}
        className="max-h-[calc(100vh-6rem)] max-w-[calc(100vw-6rem)] object-contain select-none rounded-md"
        style={{
          aspectRatio:
            attachment.width && attachment.height
              ? `${attachment.width}/${attachment.height}`
              : undefined,
        }}
        draggable={false}
        width={attachment.width || undefined}
        height={attachment.height || undefined}
      />
      {!loaded && (
        <img
          key={fullSrc}
          src={fullSrc}
          alt=""
          className="hidden"
          onLoad={() => setLoaded(true)}
        />
      )}
    </div>
  );
}

function EncryptedViewerImage({
  attachment,
  channelId,
}: {
  attachment: Attachment;
  channelId: string;
}) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [fullUrl, setFullUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const mountedRef = useRef(true);
  const thumbKey = `viewer-thumb-${attachment.id}`;
  const fullKey = `viewer-full-${attachment.id}`;

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    (async () => {
      try {
        // Unwrap the file key once
        const fileKey = await unwrapFileKey(channelId, attachment.encryptedKey);
        if (cancelled) return;

        // Decrypt thumbnail first for immediate display
        if (attachment.hasThumbnail) {
          const encThumb = await fetchEncryptedMedia(attachment.id, true);
          if (cancelled) return;
          const thumbBytes = await decryptFile(fileKey, encThumb);
          if (cancelled) return;
          const blob = new Blob([thumbBytes as BlobPart], {
            type: 'image/webp',
          });
          const url = acquireBlobURL(thumbKey, blob);
          if (mountedRef.current) setThumbUrl(url);
        }

        // Then fetch + decrypt full resolution
        const encFull = await fetchEncryptedMedia(attachment.id);
        if (cancelled) return;
        const fullBytes = await decryptFile(fileKey, encFull);
        if (cancelled) return;
        const blob = new Blob([fullBytes as BlobPart], {
          type: attachment.contentType,
        });
        const url = acquireBlobURL(fullKey, blob);
        if (mountedRef.current) setFullUrl(url);
      } catch (err) {
        console.error(
          `[E2EE] Viewer decrypt failed for ${attachment.id}:`,
          err,
        );
        if (mountedRef.current) setError(true);
      }
    })();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      releaseBlobURL(thumbKey);
      releaseBlobURL(fullKey);
    };
  }, [attachment, channelId, thumbKey, fullKey]);

  const displayUrl = fullUrl ?? thumbUrl;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation wrapper, not interactive
    <div
      className="relative flex items-center justify-center"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      role="presentation"
    >
      {displayUrl ? (
        <img
          src={displayUrl}
          alt={attachment.filename}
          className="max-h-[calc(100vh-6rem)] max-w-[calc(100vw-6rem)] object-contain select-none rounded-md"
          style={{
            aspectRatio:
              attachment.width && attachment.height
                ? `${attachment.width}/${attachment.height}`
                : undefined,
          }}
          draggable={false}
          width={attachment.width || undefined}
          height={attachment.height || undefined}
        />
      ) : error ? (
        <div className="text-text-muted text-sm">Decrypt failed</div>
      ) : (
        <div className="text-text-muted text-sm animate-pulse">
          Decrypting...
        </div>
      )}
    </div>
  );
}

export function ImageViewer() {
  const { open, attachments, channelId, currentIndex, closeViewer, setIndex } =
    useImageViewerStore();

  const handleOpenChange = (value: boolean) => {
    if (!value) {
      closeViewer();
    }
  };

  if (!open || attachments.length === 0) {
    return null;
  }

  const current = attachments[currentIndex];
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < attachments.length - 1;
  const hasMultiple = attachments.length > 1;

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out" />
        <Dialog.Content
          className="fixed inset-0 z-50 flex items-center justify-center data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus();
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' && hasPrev) {
              e.preventDefault();
              setIndex(currentIndex - 1);
            }
            if (e.key === 'ArrowRight' && hasNext) {
              e.preventDefault();
              setIndex(currentIndex + 1);
            }
          }}
          tabIndex={-1}
          aria-roledescription="image viewer"
          aria-describedby={undefined}
          onClick={() => closeViewer()}
        >
          <Dialog.Title className="sr-only">
            Viewing image: {current.filename}
          </Dialog.Title>
          {hasMultiple && hasPrev && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setIndex(currentIndex - 1);
              }}
              className="absolute left-4 top-1/2 -translate-y-1/2 bg-black/50 hover:bg-black/70 text-white/80 hover:text-white rounded-full p-2"
              aria-label="Previous image"
            >
              <CaretLeftIcon size={20} aria-hidden="true" />
            </button>
          )}
          {isEncrypted(current) ? (
            <EncryptedViewerImage attachment={current} channelId={channelId} />
          ) : (
            <ViewerImage attachment={current} />
          )}
          {hasMultiple && hasNext && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setIndex(currentIndex + 1);
              }}
              className="absolute right-4 top-1/2 -translate-y-1/2 bg-black/50 hover:bg-black/70 text-white/80 hover:text-white rounded-full p-2"
              aria-label="Next image"
            >
              <CaretRightIcon size={20} aria-hidden="true" />
            </button>
          )}
          {hasMultiple && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/50 text-white/80 text-sm px-3 py-1 rounded-full">
              {currentIndex + 1} / {attachments.length}
            </div>
          )}
          <Dialog.Close className="absolute right-4 top-4 bg-black/50 hover:bg-black/70 text-white/80 hover:text-white rounded-full p-2">
            <XIcon weight="regular" size={14} aria-hidden="true" />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
