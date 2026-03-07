/**
 * Client-side thumbnail generation for E2EE attachments.
 *
 * Images: createImageBitmap + OffscreenCanvas for resize.
 * Videos: hidden <video> element + seek + canvas capture.
 *
 * Produces two outputs per file:
 *   - thumb: ~500px max dimension, WebP quality 0.7 (encrypted, uploaded to S3)
 *   - micro: ~20px max dimension, WebP quality 0.6 (embedded in message JSON as base64)
 */

const THUMB_MAX_DIM = 500;
const MICRO_MAX_DIM = 20;
const THUMB_QUALITY = 0.7;
const MICRO_QUALITY = 0.6;
const VIDEO_SEEK_TIMEOUT_MS = 5000;

interface ThumbnailResult {
  thumb: Blob;
  micro: Blob;
  width: number;
  height: number;
}

/**
 * Compute scaled dimensions that fit within maxDim while preserving aspect ratio.
 */
function fitDimensions(
  srcWidth: number,
  srcHeight: number,
  maxDim: number,
): { width: number; height: number } {
  if (srcWidth <= maxDim && srcHeight <= maxDim) {
    return { width: srcWidth, height: srcHeight };
  }
  const scale = maxDim / Math.max(srcWidth, srcHeight);
  return {
    width: Math.round(srcWidth * scale),
    height: Math.round(srcHeight * scale),
  };
}

/**
 * Render an ImageBitmap to a WebP blob at the given dimensions and quality.
 * Uses OffscreenCanvas when available, falls back to HTMLCanvasElement for
 * iOS < 16.4 / WKWebView contexts where OffscreenCanvas is unsupported.
 */
async function renderToBlob(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  quality: number,
): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get OffscreenCanvas 2d context');
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas.convertToBlob({ type: 'image/webp', quality });
  }

  // Fallback: HTMLCanvasElement (works on all iOS versions with createImageBitmap)
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get canvas 2d context');
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))),
      'image/webp',
      quality,
    );
  });
}

/**
 * Generate display and micro thumbnails from an image blob.
 * Returns original dimensions (before any resize).
 */
export async function generateImageThumbnail(
  blob: Blob,
): Promise<ThumbnailResult> {
  const bitmap = await createImageBitmap(blob);
  const { width: srcW, height: srcH } = bitmap;

  const thumbDims = fitDimensions(srcW, srcH, THUMB_MAX_DIM);
  const microDims = fitDimensions(srcW, srcH, MICRO_MAX_DIM);

  const [thumb, micro] = await Promise.all([
    renderToBlob(bitmap, thumbDims.width, thumbDims.height, THUMB_QUALITY),
    renderToBlob(bitmap, microDims.width, microDims.height, MICRO_QUALITY),
  ]);

  bitmap.close();

  return { thumb, micro, width: srcW, height: srcH };
}

/**
 * Generate display and micro thumbnails from a video file.
 * Seeks to min(1s, 10% of duration) and captures a poster frame.
 * Returns null on timeout or error (video still uploads, just without preview).
 */
export async function generateVideoThumbnail(
  file: File,
): Promise<ThumbnailResult | null> {
  const url = URL.createObjectURL(file);
  try {
    return await extractVideoFrame(url);
  } catch (err) {
    console.warn('[E2EE] Video thumbnail generation failed:', err);
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function extractVideoFrame(url: string): Promise<ThumbnailResult> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Video thumbnail timed out'));
    }, VIDEO_SEEK_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      video.src = '';
      video.load();
    }

    function onError() {
      cleanup();
      reject(new Error('Video load error'));
    }

    async function onSeeked() {
      try {
        const srcW = video.videoWidth;
        const srcH = video.videoHeight;
        const bitmap = await createImageBitmap(video);

        const thumbDims = fitDimensions(srcW, srcH, THUMB_MAX_DIM);
        const microDims = fitDimensions(srcW, srcH, MICRO_MAX_DIM);

        const [thumb, micro] = await Promise.all([
          renderToBlob(
            bitmap,
            thumbDims.width,
            thumbDims.height,
            THUMB_QUALITY,
          ),
          renderToBlob(
            bitmap,
            microDims.width,
            microDims.height,
            MICRO_QUALITY,
          ),
        ]);

        bitmap.close();
        cleanup();
        resolve({ thumb, micro, width: srcW, height: srcH });
      } catch (err) {
        cleanup();
        reject(err);
      }
    }

    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });

    video.addEventListener(
      'loadedmetadata',
      () => {
        const seekTime = Math.min(1, video.duration * 0.1);
        video.currentTime = seekTime;
      },
      { once: true },
    );

    video.src = url;
  });
}
