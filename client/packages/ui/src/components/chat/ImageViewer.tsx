import type { Attachment } from '@meza/core';
import {
  acquireBlobURL,
  decryptFile,
  fetchEncryptedMedia,
  getMediaURL,
  isSessionReady,
  onSessionReady,
  releaseBlobURL,
  unwrapFileKey,
} from '@meza/core';
import {
  CaretLeftIcon,
  CaretRightIcon,
  EyeSlashIcon,
  XIcon,
} from '@phosphor-icons/react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useContentWarningStore } from '../../stores/contentWarnings.ts';
import { useImageViewerStore } from '../../stores/imageViewer.ts';

const SWIPE_THRESHOLD = 50;
const DIRECTION_LOCK_THRESHOLD = 10;
const SWIPE_ANIMATE_MS = 200;

// ── Decrypted URL cache ──
// Keeps blob URLs alive for the viewer session so swiping back
// to a previously viewed image is instant.

type DecryptCache = Map<string, string>;
const DecryptCacheCtx = createContext<DecryptCache>(new Map());

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
      className="relative flex items-center justify-center touch-none"
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
  const cache = useContext(DecryptCacheCtx);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [fullUrl, setFullUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [sessionOk, setSessionOk] = useState(isSessionReady);
  const mountedRef = useRef(true);
  const thumbKey = `viewer-thumb-${attachment.id}`;
  const fullKey = `viewer-full-${attachment.id}`;

  // Check cache for an already-decrypted URL
  useEffect(() => {
    const cached = cache.get(fullKey);
    if (cached) {
      setFullUrl(cached);
    }
  }, [cache, fullKey]);

  // Wait for E2EE session to be ready before attempting decryption
  useEffect(() => {
    if (sessionOk) return;
    return onSessionReady(() => setSessionOk(true));
  }, [sessionOk]);

  useEffect(() => {
    // Skip decryption if already cached
    if (cache.has(fullKey)) return;

    mountedRef.current = true;
    if (!sessionOk) return;
    let cancelled = false;

    (async () => {
      try {
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
        // Acquire a second ref for the session cache — the component's ref is
        // released on effect cleanup while the cache ref survives across swipes
        // and is released when the viewer closes (see viewer-close effect).
        acquireBlobURL(fullKey, blob);
        cache.set(fullKey, url);
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
  }, [attachment, channelId, thumbKey, fullKey, sessionOk, cache]);

  const displayUrl = fullUrl ?? thumbUrl;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation wrapper, not interactive
    <div
      className="relative flex items-center justify-center touch-none"
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

function ViewerSpoilerGate({
  attachment,
  channelId,
}: {
  attachment: Attachment;
  channelId: string;
}) {
  const revealed = useContentWarningStore((s) =>
    s.isSpoilerRevealed(attachment.id),
  );
  const reveal = useContentWarningStore((s) => s.revealSpoiler);

  if (attachment.isSpoiler && !revealed) {
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation wrapper
      <div
        className="flex items-center justify-center"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="presentation"
      >
        <button
          type="button"
          onClick={() => reveal(attachment.id)}
          className="flex flex-col items-center gap-3 rounded-xl bg-bg-elevated/80 px-8 py-6 text-text-muted hover:text-text transition-colors"
          aria-label="Reveal spoiler image"
        >
          <EyeSlashIcon size={32} aria-hidden="true" />
          <span className="text-sm font-medium">Spoiler — click to reveal</span>
        </button>
      </div>
    );
  }

  return isEncrypted(attachment) ? (
    <EncryptedViewerImage attachment={attachment} channelId={channelId} />
  ) : (
    <ViewerImage attachment={attachment} />
  );
}

export function ImageViewer() {
  const { open, attachments, channelId, currentIndex, closeViewer, setIndex } =
    useImageViewerStore();

  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < attachments.length - 1;

  // Swipe tracking state persisted across renders via refs
  const touchRef = useRef({
    startX: 0,
    startY: 0,
    tracking: false,
    directionLocked: false,
    swiped: false,
    animating: false,
  });

  // Session-scoped cache for decrypted blob URLs
  const cacheRef = useRef<DecryptCache>(new Map());

  // Release all cached blob URLs when the viewer closes
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (prevOpenRef.current && !open) {
      for (const key of cacheRef.current.keys()) {
        releaseBlobURL(key);
      }
      cacheRef.current.clear();
    }
    prevOpenRef.current = open;
  }, [open]);

  const animateSwipe = useCallback(
    (el: HTMLElement, direction: 'left' | 'right') => {
      const t = touchRef.current;
      t.animating = true;
      t.swiped = true;
      el.style.transition = `transform ${SWIPE_ANIMATE_MS}ms ease-out`;
      el.style.transform = `translateX(${direction === 'left' ? '-100vw' : '100vw'})`;

      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        el.removeEventListener('transitionend', finish);
        el.style.transition = '';
        el.style.transform = '';
        t.animating = false;
        if (direction === 'left') {
          setIndex(currentIndex + 1);
        } else {
          setIndex(currentIndex - 1);
        }
      };
      el.addEventListener('transitionend', finish, { once: true });
      // Safety fallback in case transitionend doesn't fire
      setTimeout(finish, SWIPE_ANIMATE_MS + 50);
    },
    [currentIndex, setIndex],
  );

  const handleOpenChange = (value: boolean) => {
    if (!value) {
      closeViewer();
    }
  };

  if (!open || attachments.length === 0) {
    return null;
  }

  const current = attachments[currentIndex];
  const hasMultiple = attachments.length > 1;

  return (
    <DecryptCacheCtx.Provider value={cacheRef.current}>
      <Dialog.Root open={open} onOpenChange={handleOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out" />
          <Dialog.Content
            className="fixed inset-0 z-50 flex items-center justify-center data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out touch-pan-y"
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
            onTouchStart={(e) => {
              const t = touchRef.current;
              if (t.animating) return;
              const touch = e.touches[0];
              if (!touch) return;
              t.startX = touch.clientX;
              t.startY = touch.clientY;
              t.tracking = true;
              t.directionLocked = false;
              t.swiped = false;

              const imageEl =
                e.currentTarget.querySelector<HTMLElement>(
                  '[role="presentation"]',
                );
              if (imageEl) imageEl.style.transition = 'none';
            }}
            onTouchMove={(e) => {
              const t = touchRef.current;
              if (!t.tracking) return;
              const touch = e.touches[0];
              if (!touch) return;
              const dx = touch.clientX - t.startX;
              const dy = touch.clientY - t.startY;

              if (
                !t.directionLocked &&
                (Math.abs(dx) > DIRECTION_LOCK_THRESHOLD ||
                  Math.abs(dy) > DIRECTION_LOCK_THRESHOLD)
              ) {
                t.directionLocked = true;
                if (Math.abs(dy) > Math.abs(dx)) {
                  t.tracking = false;
                  const imageEl =
                    e.currentTarget.querySelector<HTMLElement>(
                      '[role="presentation"]',
                    );
                  if (imageEl) {
                    imageEl.style.transition = '';
                    imageEl.style.transform = '';
                  }
                  return;
                }
              }

              if (t.directionLocked) {
                const imageEl =
                  e.currentTarget.querySelector<HTMLElement>(
                    '[role="presentation"]',
                  );
                if (imageEl) {
                  let clampedDx = dx;
                  if (dx > 0 && !hasPrev) clampedDx = dx * 0.3;
                  if (dx < 0 && !hasNext) clampedDx = dx * 0.3;
                  imageEl.style.transform = `translateX(${clampedDx}px)`;
                }
              }
            }}
            onTouchEnd={(e) => {
              const t = touchRef.current;
              if (!t.tracking) return;
              t.tracking = false;
              const touch = e.changedTouches[0];
              if (!touch) {
                const imageEl =
                  e.currentTarget.querySelector<HTMLElement>(
                    '[role="presentation"]',
                  );
                if (imageEl) {
                  imageEl.style.transition = '';
                  imageEl.style.transform = '';
                }
                return;
              }
              const dx = touch.clientX - t.startX;

              const imageEl =
                e.currentTarget.querySelector<HTMLElement>(
                  '[role="presentation"]',
                );

              if (dx < -SWIPE_THRESHOLD && hasNext && imageEl) {
                // Animate off to the left, then advance
                animateSwipe(imageEl, 'left');
              } else if (dx > SWIPE_THRESHOLD && hasPrev && imageEl) {
                // Animate off to the right, then go back
                animateSwipe(imageEl, 'right');
              } else if (imageEl) {
                // Snap back to center
                imageEl.style.transition = `transform ${SWIPE_ANIMATE_MS}ms ease-out`;
                imageEl.style.transform = '';
                const cleanup = () => {
                  imageEl.removeEventListener('transitionend', cleanup);
                  imageEl.style.transition = '';
                };
                imageEl.addEventListener('transitionend', cleanup, {
                  once: true,
                });
              }
            }}
            tabIndex={-1}
            aria-roledescription="image viewer"
            aria-describedby={undefined}
            onClick={() => {
              if (!touchRef.current.swiped) closeViewer();
            }}
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
            <ViewerSpoilerGate attachment={current} channelId={channelId} />
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
            <Dialog.Close className="absolute right-4 top-[max(1rem,env(safe-area-inset-top,1rem))] bg-black/50 hover:bg-black/70 text-white/80 hover:text-white rounded-full p-2">
              <XIcon weight="regular" size={14} aria-hidden="true" />
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </DecryptCacheCtx.Provider>
  );
}
