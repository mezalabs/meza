import { createClient } from '@connectrpc/connect';
import { MediaService, UploadPurpose } from '@meza/gen/meza/v1/media_pb.ts';
import {
  encryptFile,
  generateFileKey,
  wrapFileKey,
} from '../crypto/file-encryption.ts';
import {
  generateImageThumbnail,
  generateVideoThumbnail,
} from '../crypto/thumbnails.ts';
import { useAuthStore } from '../store/auth.ts';
import { getBaseUrl, isCapacitor } from '../utils/platform.ts';
import { transport } from './client.ts';

/**
 * On Capacitor the WebView origin differs from the S3/MinIO host.
 * Strip the origin from presigned URLs so requests route through the
 * same-origin Vite proxy (dev) or the app's configured proxy (prod),
 * avoiding CORS issues and unreachable hosts (e.g. localhost:9000).
 */
function normalizePresignedUrl(url: string): string {
  if (!isCapacitor()) return url;
  try {
    const u = new URL(url);
    // MinIO path-style URLs always include the bucket name in the path.
    if (u.pathname.startsWith('/meza-media/')) {
      return `${u.pathname}${u.search}`;
    }
  } catch {
    // not a full URL, return as-is
  }
  return url;
}

const mediaClient = createClient(MediaService, transport);

export async function createUpload(
  filename: string,
  contentType: string,
  sizeBytes: number,
  purpose: UploadPurpose,
  originalContentType?: string,
): Promise<{
  uploadId: string;
  uploadUrl: string;
  thumbnailUploadUrl: string;
}> {
  const res = await mediaClient.createUpload({
    filename,
    contentType,
    sizeBytes: BigInt(sizeBytes),
    purpose,
    originalContentType: originalContentType ?? '',
  });
  return {
    uploadId: res.uploadId,
    uploadUrl: normalizePresignedUrl(res.uploadUrl),
    thumbnailUploadUrl: normalizePresignedUrl(res.thumbnailUploadUrl),
  };
}

export async function completeUpload(
  uploadId: string,
  opts?: {
    width?: number;
    height?: number;
    encryptedKey?: Uint8Array;
  },
): Promise<{
  attachmentId: string;
  url: string;
  hasThumbnail: boolean;
  width: number;
  height: number;
  microThumbnail: Uint8Array;
}> {
  const res = await mediaClient.completeUpload({
    uploadId,
    width: opts?.width ?? 0,
    height: opts?.height ?? 0,
    encryptedKey: opts?.encryptedKey ?? new Uint8Array(),
  });
  return {
    attachmentId: res.attachmentId,
    url: res.url,
    hasThumbnail: res.hasThumbnail,
    width: res.width,
    height: res.height,
    microThumbnail: res.microThumbnail,
  };
}

export async function getDownloadURL(
  attachmentId: string,
  thumbnail = false,
): Promise<string> {
  const res = await mediaClient.getDownloadURL({ attachmentId, thumbnail });
  return normalizePresignedUrl(res.url);
}

/**
 * Fetch encrypted media bytes from the server.
 * Downloads via presigned URL and returns the raw encrypted bytes.
 */
export async function fetchEncryptedMedia(
  attachmentId: string,
  thumbnail = false,
): Promise<Uint8Array> {
  const url = await getDownloadURL(attachmentId, thumbnail);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch media: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * High-level helper that orchestrates the full upload flow:
 * 1. CreateUpload -> get presigned URL
 * 2. PUT file to presigned URL (via XHR for progress tracking)
 * 3. CompleteUpload -> get attachment ID + URLs
 */
export async function uploadFile(
  file: File,
  purpose: UploadPurpose,
  onProgress?: (percent: number) => void,
): Promise<{
  attachmentId: string;
  url: string;
  hasThumbnail: boolean;
  width: number;
  height: number;
  microThumbnail: Uint8Array;
}> {
  const { uploadId, uploadUrl } = await createUpload(
    file.name,
    file.type,
    file.size,
    purpose,
  );

  await putFile(uploadUrl, file.type, file, onProgress);

  return completeUpload(uploadId);
}

export interface EncryptedUploadResult {
  attachmentId: string;
  width: number;
  height: number;
  microThumbnail: Uint8Array;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

/**
 * Encrypt and upload a file for a chat attachment.
 *
 * 1. Generate per-file AES-256-GCM key
 * 2. Generate thumbnail + micro-thumbnail (images/videos)
 * 3. Encrypt file + thumbnail with the file key
 * 4. Wrap file key with channel key
 * 5. CreateUpload (application/octet-stream + original_content_type)
 * 6. PUT encrypted file + thumbnail to presigned URLs
 * 7. CompleteUpload with dimensions + wrapped key
 */
export async function uploadEncryptedFile(
  file: File,
  channelId: string,
  onProgress?: (percent: number) => void,
): Promise<EncryptedUploadResult> {
  // 1. Read file bytes
  const fileBytes = new Uint8Array(await file.arrayBuffer());

  // 2. Generate per-file key
  const fileKey = generateFileKey();

  // 3. Generate thumbnails based on content type
  let thumbBlob: Blob | null = null;
  let microBlob: Blob | null = null;
  let width = 0;
  let height = 0;

  if (file.type.startsWith('image/')) {
    const result = await generateImageThumbnail(file);
    thumbBlob = result.thumb;
    microBlob = result.micro;
    width = result.width;
    height = result.height;
  } else if (file.type.startsWith('video/')) {
    const result = await generateVideoThumbnail(file);
    if (result) {
      thumbBlob = result.thumb;
      microBlob = result.micro;
      width = result.width;
      height = result.height;
    }
  }

  // 4. Encrypt file
  const encryptedFile = await encryptFile(fileKey, fileBytes);

  // 5. Encrypt thumbnail (if exists)
  let encryptedThumb: Uint8Array | null = null;
  if (thumbBlob) {
    const thumbBytes = new Uint8Array(await thumbBlob.arrayBuffer());
    encryptedThumb = await encryptFile(fileKey, thumbBytes);
  }

  // 6. Wrap file key with channel key (returns version-prefixed envelope)
  const encryptedKey = await wrapFileKey(channelId, fileKey);

  // 7. CreateUpload
  const { uploadId, uploadUrl, thumbnailUploadUrl } = await createUpload(
    file.name,
    'application/octet-stream',
    encryptedFile.length,
    UploadPurpose.CHAT_ATTACHMENT,
    file.type,
  );

  // 8. Upload encrypted file + thumbnail in parallel
  const uploads: Promise<void>[] = [
    putFile(uploadUrl, 'application/octet-stream', encryptedFile, onProgress),
  ];
  if (encryptedThumb && thumbnailUploadUrl) {
    uploads.push(
      putFile(thumbnailUploadUrl, 'application/octet-stream', encryptedThumb),
    );
  }
  await Promise.all(uploads);

  // 9. CompleteUpload with dimensions + encrypted key envelope
  const result = await completeUpload(uploadId, {
    width,
    height,
    encryptedKey,
  });

  // 10. Read micro-thumbnail bytes for message JSON
  const microBytes = microBlob
    ? new Uint8Array(await microBlob.arrayBuffer())
    : new Uint8Array();

  return {
    attachmentId: result.attachmentId,
    width,
    height,
    microThumbnail: microBytes,
    filename: file.name,
    contentType: file.type,
    sizeBytes: file.size,
  };
}

/**
 * PUT data to a presigned URL via XHR (supports progress tracking).
 */
function putFile(
  url: string,
  contentType: string,
  data: File | Uint8Array,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed: ${xhr.status}`));
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    // XHR.send accepts File natively but not Uint8Array — use ArrayBuffer
    if (data instanceof Uint8Array) {
      xhr.send(
        data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength,
        ) as ArrayBuffer,
      );
    } else {
      xhr.send(data);
    }
  });
}

/**
 * Returns a media URL that 302-redirects to a fresh presigned S3 URL.
 * Includes the access token as a query parameter so browser-initiated
 * requests (<img src>, <video><source src>) pass authentication.
 */
export function getMediaURL(attachmentId: string, thumbnail = false): string {
  const prefix = getBaseUrl();
  const mediaPath = `/media/${attachmentId}`;
  const fullPath = thumbnail ? `${mediaPath}/thumb` : mediaPath;
  const url = `${prefix}${fullPath}`;
  const token = useAuthStore.getState().accessToken;
  return token ? `${url}?token=${encodeURIComponent(token)}` : url;
}

export { UploadPurpose };
