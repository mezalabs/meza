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
import { EyeSlashIcon, FileTextIcon } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useContentWarningStore } from '../../stores/contentWarnings.ts';
import { useImageViewerStore } from '../../stores/imageViewer.ts';

function formatFileSize(bytes: bigint): string {
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Convert raw bytes to a base64 data URI for inline display. */
function microThumbDataURI(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return `data:image/webp;base64,${btoa(binary)}`;
}

/** Check if an attachment is encrypted (has a wrapped file key). */
function isEncrypted(attachment: Attachment): boolean {
  return attachment.encryptedKey.length > 0;
}

// --- Shared hook for decrypting and displaying an encrypted thumbnail ---

function useDecryptedThumbnail(
  attachment: Attachment,
  channelId: string,
): { blobUrl: string | null; error: boolean } {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [sessionOk, setSessionOk] = useState(isSessionReady);
  const mountedRef = useRef(true);
  const thumbKey = `thumb-${attachment.id}`;

  // Wait for E2EE session to be ready before attempting decryption
  useEffect(() => {
    if (sessionOk) return;
    return onSessionReady(() => setSessionOk(true));
  }, [sessionOk]);

  useEffect(() => {
    mountedRef.current = true;
    // Reset error on re-run (e.g., attachment updated with encryptedKey from gateway echo)
    setError(false);
    if (!sessionOk || !isEncrypted(attachment) || !attachment.hasThumbnail)
      return;
    // Skip if encryptedKey is missing — the gateway echo hasn't merged yet.
    // The effect will re-run once the attachment reference updates.
    if (attachment.encryptedKey.length === 0) return;

    let cancelled = false;
    (async () => {
      try {
        const encThumb = await fetchEncryptedMedia(attachment.id, true);
        if (cancelled) return;
        const fileKey = await unwrapFileKey(channelId, attachment.encryptedKey);
        if (cancelled) return;
        const thumbBytes = await decryptFile(fileKey, encThumb);
        if (cancelled) return;
        const blob = new Blob([thumbBytes as BlobPart], {
          type: attachment.contentType.startsWith('video/')
            ? 'image/webp'
            : attachment.contentType,
        });
        const url = acquireBlobURL(thumbKey, blob);
        if (mountedRef.current) setBlobUrl(url);
      } catch (err) {
        console.error(
          `[E2EE] Thumbnail decrypt failed for ${attachment.id}:`,
          err,
        );
        if (mountedRef.current) setError(true);
      }
    })();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      releaseBlobURL(thumbKey);
    };
  }, [attachment, channelId, thumbKey, sessionOk]);

  return { blobUrl, error };
}

// --- Plaintext components (existing) ---

function ImageAttachment({
  attachment,
  allImageAttachments,
  indexInGroup,
  channelId,
  cover,
}: {
  attachment: Attachment;
  allImageAttachments: Attachment[];
  indexInGroup: number;
  channelId: string;
  cover?: boolean;
}) {
  const [thumbLoaded, setThumbLoaded] = useState(false);
  const [thumbError, setThumbError] = useState(false);
  const thumbSrc = getMediaURL(attachment.id, attachment.hasThumbnail);
  const openViewer = useImageViewerStore((s) => s.openViewer);

  const hasMicroThumb = attachment.microThumbnail.length > 0;
  const hasAspectRatio = attachment.width > 0 && attachment.height > 0;

  return (
    <button
      type="button"
      onClick={() => openViewer(allImageAttachments, indexInGroup, channelId)}
      className="cursor-pointer rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus relative overflow-hidden"
      aria-label={`View ${attachment.filename} in image viewer`}
      style={
        hasAspectRatio && !cover
          ? {
              aspectRatio: `${attachment.width}/${attachment.height}`,
              maxWidth: Math.min(400, attachment.width),
              maxHeight: 300,
            }
          : cover
            ? { width: '100%', height: '100%' }
            : { maxWidth: 400, maxHeight: 300 }
      }
    >
      {/* Micro thumbnail placeholder (instant, blurred) */}
      {hasMicroThumb && !thumbLoaded && !thumbError && (
        <img
          src={microThumbDataURI(attachment.microThumbnail)}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 w-full h-full object-cover blur-xl scale-110 rounded-md"
        />
      )}

      {/* Display thumbnail (loaded from S3) */}
      <img
        src={thumbSrc}
        alt={attachment.filename}
        loading="lazy"
        decoding="async"
        className={`rounded-md transition-opacity duration-300 ${
          cover
            ? 'w-full h-full object-cover'
            : 'max-w-full max-h-[300px] object-contain'
        } ${thumbLoaded ? 'opacity-100' : hasMicroThumb ? 'opacity-0' : 'opacity-100'}`}
        width={!cover && attachment.width ? attachment.width : undefined}
        height={!cover && attachment.height ? attachment.height : undefined}
        onLoad={() => setThumbLoaded(true)}
        onError={() => setThumbError(true)}
      />
    </button>
  );
}

/** Grid layout for multiple image attachments. */
function ImageGrid({
  images,
  allImageAttachments,
  channelId,
}: {
  images: Attachment[];
  allImageAttachments: Attachment[];
  channelId: string;
}) {
  const count = images.length;

  if (count === 1) {
    const att = images[0];
    return isEncrypted(att) ? (
      <EncryptedImageAttachment
        attachment={att}
        allImageAttachments={allImageAttachments}
        indexInGroup={allImageAttachments.indexOf(att)}
        channelId={channelId}
      />
    ) : (
      <ImageAttachment
        attachment={att}
        allImageAttachments={allImageAttachments}
        indexInGroup={allImageAttachments.indexOf(att)}
        channelId={channelId}
      />
    );
  }

  // For 2+ images, use a grid with object-fit: cover
  const gridClass =
    count === 2
      ? 'grid grid-cols-2 gap-1'
      : count === 3
        ? 'grid grid-cols-2 grid-rows-2 gap-1'
        : 'grid grid-cols-2 gap-1';

  return (
    <div className={`${gridClass} max-w-[400px] rounded-md overflow-hidden`}>
      {images.map((img, i) => (
        <div
          key={img.id}
          className={`relative ${count === 3 && i === 0 ? 'row-span-2' : ''}`}
          style={{ aspectRatio: count === 3 && i === 0 ? '1/2' : '1/1' }}
        >
          {isEncrypted(img) ? (
            <EncryptedImageAttachment
              attachment={img}
              allImageAttachments={allImageAttachments}
              indexInGroup={allImageAttachments.indexOf(img)}
              channelId={channelId}
              cover
            />
          ) : (
            <ImageAttachment
              attachment={img}
              allImageAttachments={allImageAttachments}
              indexInGroup={allImageAttachments.indexOf(img)}
              channelId={channelId}
              cover
            />
          )}
        </div>
      ))}
    </div>
  );
}

function VideoAttachment({ attachment }: { attachment: Attachment }) {
  const src = getMediaURL(attachment.id);

  return (
    <video
      controls
      preload="metadata"
      className="max-w-[400px] max-h-[300px] rounded-md"
    >
      <source src={src} type={attachment.contentType} />
      <track kind="captions" />
    </video>
  );
}

function FileAttachment({ attachment }: { attachment: Attachment }) {
  const src = getMediaURL(attachment.id);

  return (
    <a
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 rounded-md border border-border bg-bg-elevated px-3 py-2 hover:bg-bg-surface transition-colors max-w-[300px]"
    >
      <FileTextIcon
        size={20}
        className="flex-shrink-0 text-text-muted"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-text truncate">{attachment.filename}</p>
        <p className="text-xs text-text-muted">
          {formatFileSize(attachment.sizeBytes)}
        </p>
      </div>
    </a>
  );
}

// --- Encrypted components ---

function EncryptedImageAttachment({
  attachment,
  allImageAttachments,
  indexInGroup,
  channelId,
  cover,
}: {
  attachment: Attachment;
  allImageAttachments: Attachment[];
  indexInGroup: number;
  channelId: string;
  cover?: boolean;
}) {
  const { blobUrl, error } = useDecryptedThumbnail(attachment, channelId);
  const openViewer = useImageViewerStore((s) => s.openViewer);

  const hasMicroThumb = attachment.microThumbnail.length > 0;
  const hasAspectRatio = attachment.width > 0 && attachment.height > 0;

  return (
    <button
      type="button"
      onClick={() => openViewer(allImageAttachments, indexInGroup, channelId)}
      className="cursor-pointer rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus relative overflow-hidden"
      aria-label={`View ${attachment.filename} in image viewer`}
      style={
        hasAspectRatio && !cover
          ? {
              aspectRatio: `${attachment.width}/${attachment.height}`,
              maxWidth: Math.min(400, attachment.width),
              maxHeight: 300,
            }
          : cover
            ? { width: '100%', height: '100%' }
            : { maxWidth: 400, maxHeight: 300 }
      }
    >
      {/* Micro thumbnail placeholder (instant, blurred) */}
      {hasMicroThumb && !blobUrl && !error && (
        <img
          src={microThumbDataURI(attachment.microThumbnail)}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 w-full h-full object-cover blur-xl scale-110 rounded-md"
        />
      )}

      {/* Decrypted thumbnail */}
      {blobUrl && (
        <img
          src={blobUrl}
          alt={attachment.filename}
          className={`rounded-md ${
            cover
              ? 'w-full h-full object-cover'
              : 'max-w-full max-h-[300px] object-contain'
          }`}
          width={!cover && attachment.width ? attachment.width : undefined}
          height={!cover && attachment.height ? attachment.height : undefined}
        />
      )}

      {/* Error state */}
      {error && (
        <div className="flex items-center justify-center w-full h-full min-h-[60px] text-text-muted text-xs">
          Decrypt failed
        </div>
      )}
    </button>
  );
}

function EncryptedVideoAttachment({
  attachment,
  channelId,
}: {
  attachment: Attachment;
  channelId: string;
}) {
  const { blobUrl: posterUrl } = useDecryptedThumbnail(attachment, channelId);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const videoKey = `video-${attachment.id}`;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      releaseBlobURL(videoKey);
    };
  }, [videoKey]);

  async function handlePlay() {
    if (videoUrl || busyRef.current || !isSessionReady()) return;
    busyRef.current = true;
    setLoading(true);
    setError(false);
    try {
      const encVideo = await fetchEncryptedMedia(attachment.id);
      if (!mountedRef.current) return;
      const fileKey = await unwrapFileKey(channelId, attachment.encryptedKey);
      if (!mountedRef.current) return;
      const videoBytes = await decryptFile(fileKey, encVideo);
      if (!mountedRef.current) return;
      const blob = new Blob([videoBytes as BlobPart], {
        type: attachment.contentType,
      });
      const url = acquireBlobURL(videoKey, blob);
      if (mountedRef.current) setVideoUrl(url);
    } catch (err) {
      console.error(`[E2EE] Video decrypt failed for ${attachment.id}:`, err);
      if (mountedRef.current) setError(true);
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }

  if (videoUrl) {
    return (
      <video
        controls
        autoPlay
        className="max-w-[400px] max-h-[300px] rounded-md"
        src={videoUrl}
      >
        <track kind="captions" />
      </video>
    );
  }

  const hasMicroThumb = attachment.microThumbnail.length > 0;

  return (
    <button
      type="button"
      onClick={handlePlay}
      disabled={loading}
      className="relative cursor-pointer rounded-md overflow-hidden max-w-[400px] max-h-[300px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      aria-label={`Play ${attachment.filename}`}
      style={
        attachment.width > 0 && attachment.height > 0
          ? {
              aspectRatio: `${attachment.width}/${attachment.height}`,
              maxWidth: Math.min(400, attachment.width),
            }
          : { minWidth: 200, minHeight: 120 }
      }
    >
      {/* Poster or micro-thumbnail */}
      {posterUrl ? (
        <img
          src={posterUrl}
          alt=""
          className="w-full h-full object-cover rounded-md"
        />
      ) : hasMicroThumb ? (
        <img
          src={microThumbDataURI(attachment.microThumbnail)}
          alt=""
          className="w-full h-full object-cover blur-xl scale-110 rounded-md"
        />
      ) : (
        <div className="w-full h-full bg-bg-elevated rounded-md" />
      )}

      {/* Play button overlay */}
      <div className="absolute inset-0 flex items-center justify-center">
        {loading ? (
          <div className="bg-black/60 text-white text-xs px-3 py-1.5 rounded-full">
            Decrypting...
          </div>
        ) : error ? (
          <div className="bg-black/60 text-white text-xs px-3 py-1.5 rounded-full">
            Decrypt failed
          </div>
        ) : (
          <div className="bg-black/60 rounded-full p-3">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="white"
              aria-hidden="true"
            >
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        )}
      </div>
    </button>
  );
}

function EncryptedFileAttachment({
  attachment,
  channelId,
}: {
  attachment: Attachment;
  channelId: string;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function handleDownload() {
    if (busyRef.current || !isSessionReady()) return;
    busyRef.current = true;
    setLoading(true);
    setError(false);
    try {
      const encData = await fetchEncryptedMedia(attachment.id);
      if (!mountedRef.current) return;
      const fileKey = await unwrapFileKey(channelId, attachment.encryptedKey);
      if (!mountedRef.current) return;
      const fileBytes = await decryptFile(fileKey, encData);
      if (!mountedRef.current) return;
      const blob = new Blob([fileBytes as BlobPart], {
        type: attachment.contentType,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = attachment.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(`[E2EE] File decrypt failed for ${attachment.id}:`, err);
      if (mountedRef.current) setError(true);
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleDownload}
      disabled={loading}
      className="flex items-center gap-3 rounded-md border border-border bg-bg-elevated px-3 py-2 hover:bg-bg-surface transition-colors max-w-[300px] cursor-pointer"
    >
      <FileIcon />
      <div className="min-w-0 flex-1 text-left">
        <p className="text-sm text-text truncate">{attachment.filename}</p>
        <p className="text-xs text-text-muted">
          {loading
            ? 'Decrypting...'
            : error
              ? 'Decrypt failed'
              : formatFileSize(attachment.sizeBytes)}
        </p>
      </div>
    </button>
  );
}

function FileIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-shrink-0 text-text-muted"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

// --- Spoiler overlay ---

function SpoilerOverlay({ attachmentId, children }: { attachmentId: string; children: React.ReactNode }) {
  const revealed = useContentWarningStore((s) => s.isSpoilerRevealed(attachmentId));
  const reveal = useContentWarningStore((s) => s.revealSpoiler);

  if (revealed) return <>{children}</>;

  return (
    <div className="relative inline-block rounded-md overflow-hidden">
      <div className="blur-xl pointer-events-none select-none" aria-hidden="true">
        {children}
      </div>
      <button
        type="button"
        onClick={() => reveal(attachmentId)}
        className="absolute inset-0 flex items-center justify-center bg-black/40 rounded-md cursor-pointer"
        aria-label="Reveal spoiler image"
      >
        <div className="flex items-center gap-2 rounded-full bg-black/60 px-4 py-2 text-sm text-white">
          <EyeSlashIcon size={16} aria-hidden="true" />
          Spoiler
        </div>
      </button>
    </div>
  );
}

// --- Main renderer ---

export function AttachmentRenderer({
  attachments,
  channelId,
}: {
  attachments: Attachment[];
  channelId: string;
}) {
  const imageAttachments = useMemo(
    () => attachments.filter((a) => a.contentType.startsWith('image/')),
    [attachments],
  );
  const nonImageAttachments = useMemo(
    () => attachments.filter((a) => !a.contentType.startsWith('image/')),
    [attachments],
  );

  // Split images into spoiler and non-spoiler groups
  const spoilerImages = useMemo(
    () => imageAttachments.filter((a) => a.isSpoiler),
    [imageAttachments],
  );
  const normalImages = useMemo(
    () => imageAttachments.filter((a) => !a.isSpoiler),
    [imageAttachments],
  );

  if (attachments.length === 0) return null;

  function renderVideoOrFile(att: Attachment) {
    const video = att.contentType.startsWith('video/');
    const inner = video ? (
      isEncrypted(att) ? (
        <EncryptedVideoAttachment attachment={att} channelId={channelId} />
      ) : (
        <VideoAttachment attachment={att} />
      )
    ) : isEncrypted(att) ? (
      <EncryptedFileAttachment attachment={att} channelId={channelId} />
    ) : (
      <FileAttachment attachment={att} />
    );

    if (att.isSpoiler && (video || att.contentType.startsWith('image/'))) {
      return (
        <SpoilerOverlay key={att.id} attachmentId={att.id}>
          {inner}
        </SpoilerOverlay>
      );
    }
    return <div key={att.id}>{inner}</div>;
  }

  return (
    <div className="mt-1 flex flex-col gap-2">
      {normalImages.length > 0 && (
        <ImageGrid
          images={normalImages}
          allImageAttachments={imageAttachments}
          channelId={channelId}
        />
      )}
      {spoilerImages.map((att) => (
        <SpoilerOverlay key={att.id} attachmentId={att.id}>
          {isEncrypted(att) ? (
            <EncryptedImageAttachment
              attachment={att}
              allImageAttachments={imageAttachments}
              indexInGroup={imageAttachments.indexOf(att)}
              channelId={channelId}
            />
          ) : (
            <ImageAttachment
              attachment={att}
              allImageAttachments={imageAttachments}
              indexInGroup={imageAttachments.indexOf(att)}
              channelId={channelId}
            />
          )}
        </SpoilerOverlay>
      ))}
      {nonImageAttachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {nonImageAttachments.map(renderVideoOrFile)}
        </div>
      )}
    </div>
  );
}
