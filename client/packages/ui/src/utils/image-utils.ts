/** Accepted image MIME types */
export const ACCEPTED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

/** Max file size in bytes (matches server 50MB limit) */
export const MAX_IMAGE_FILE_SIZE = 50 * 1024 * 1024;

/** Max dimension for cropper input (safe for iOS Safari canvas limits) */
export const MAX_CROPPER_DIMENSION = 2048;

export interface PixelCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Validate image file before opening cropper.
 * UX guards only — server enforces actual security boundary.
 * Throws on failure with user-friendly message.
 */
export async function validateImageFile(file: File): Promise<void> {
  if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
    const allowed = Array.from(ACCEPTED_IMAGE_TYPES)
      .map((t) => t.replace('image/', '').toUpperCase())
      .join(', ');
    throw new Error(`Unsupported image type. Accepted formats: ${allowed}`);
  }

  if (file.size > MAX_IMAGE_FILE_SIZE) {
    const maxMB = Math.round(MAX_IMAGE_FILE_SIZE / (1024 * 1024));
    throw new Error(`Image is too large. Maximum file size is ${maxMB}MB`);
  }
}

/**
 * Check if a file is an animated GIF/APNG/WebP by reading magic bytes.
 * Reads only first 4KB — O(1) regardless of file size.
 */
export async function isAnimatedImage(file: File): Promise<boolean> {
  if (file.type === 'image/jpeg') return false;

  const chunkSize = Math.min(file.size, 32768);
  const buffer = await file.slice(0, chunkSize).arrayBuffer();
  const bytes = new Uint8Array(buffer);

  if (file.type === 'image/gif') {
    // Look for Graphic Control Extension (0x21 0xF9) which precedes each frame.
    // More than one occurrence means animated. This avoids false positives from
    // 0x2C appearing inside LZW data or extension blocks.
    let gceCount = 0;
    for (let i = 0; i < bytes.length - 1; i++) {
      if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9) {
        gceCount++;
        if (gceCount > 1) return true;
      }
    }
    return false;
  }

  if (file.type === 'image/png') {
    // Look for acTL chunk which signals an animated PNG
    // Chunk layout: 4-byte length, 4-byte type, data, 4-byte CRC
    // The acTL chunk type is [0x61, 0x63, 0x54, 0x4C]
    for (let i = 0; i < bytes.length - 3; i++) {
      if (
        bytes[i] === 0x61 &&
        bytes[i + 1] === 0x63 &&
        bytes[i + 2] === 0x54 &&
        bytes[i + 3] === 0x4c
      ) {
        return true;
      }
    }
    return false;
  }

  if (file.type === 'image/webp') {
    // Look for ANIM chunk which signals an animated WebP
    // The ANIM chunk FourCC is [0x41, 0x4E, 0x49, 0x4D]
    for (let i = 0; i < bytes.length - 3; i++) {
      if (
        bytes[i] === 0x41 &&
        bytes[i + 1] === 0x4e &&
        bytes[i + 2] === 0x49 &&
        bytes[i + 3] === 0x4d
      ) {
        return true;
      }
    }
    return false;
  }

  return false;
}

/**
 * Pre-scale image if dimensions exceed MAX_CROPPER_DIMENSION.
 * Uses createImageBitmap with resizeWidth/resizeHeight for subsampled decode.
 * Returns an Object URL for the (possibly scaled) image.
 */
export async function prepareImageForCropper(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  bitmap.close();

  if (width <= MAX_CROPPER_DIMENSION && height <= MAX_CROPPER_DIMENSION) {
    return URL.createObjectURL(file);
  }

  // Calculate scaled dimensions preserving aspect ratio
  const scale = Math.min(
    MAX_CROPPER_DIMENSION / width,
    MAX_CROPPER_DIMENSION / height,
  );
  const scaledWidth = Math.round(width * scale);
  const scaledHeight = Math.round(height * scale);

  const scaledBitmap = await createImageBitmap(file, {
    resizeWidth: scaledWidth,
    resizeHeight: scaledHeight,
    resizeQuality: 'high',
  });

  const canvas = new OffscreenCanvas(scaledWidth, scaledHeight);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get 2d context');
  ctx.drawImage(scaledBitmap, 0, 0);
  scaledBitmap.close();

  const blob = await canvas.convertToBlob({ type: 'image/png' });

  // Release canvas memory
  canvas.width = 1;
  canvas.height = 1;

  return URL.createObjectURL(blob);
}

/**
 * Extract cropped region from image using canvas.
 * Uses createImageBitmap with source-rect to avoid full-image canvas.
 * Always outputs JPEG at quality 0.85.
 * Returns a File object ready for uploadFile().
 */
export async function getCroppedImage(
  imageSrc: string,
  pixelCrop: PixelCrop,
  originalFileName: string,
): Promise<File> {
  const response = await fetch(imageSrc);
  const blob = await response.blob();

  const cropped = await createImageBitmap(
    blob,
    pixelCrop.x,
    pixelCrop.y,
    pixelCrop.width,
    pixelCrop.height,
  );

  const canvas = new OffscreenCanvas(pixelCrop.width, pixelCrop.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get 2d context');
  ctx.drawImage(cropped, 0, 0);
  cropped.close();

  const croppedBlob = await canvas.convertToBlob({
    type: 'image/jpeg',
    quality: 0.85,
  });

  // Release canvas memory
  canvas.width = 1;
  canvas.height = 1;

  const outputName = originalFileName.replace(/\.[^.]+$/, '.jpg');
  return new File([croppedBlob], outputName, { type: 'image/jpeg' });
}
