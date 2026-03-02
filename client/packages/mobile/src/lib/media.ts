/**
 * Mobile media handling — image picking, file encryption, upload/download.
 *
 * Uses expo-image-picker and expo-document-picker for file selection.
 * Reuses @meza/core's encryptFile/decryptFile/wrapFileKey for E2EE.
 * Mobile-specific upload since core's uploadEncryptedFile uses DOM File/Blob.
 */

import {
  completeUpload,
  createUpload,
  decryptFile,
  encryptFile,
  fetchEncryptedMedia,
  generateFileKey,
  unwrapFileKey,
  UploadPurpose,
  wrapFileKey,
  type EncryptedUploadResult,
} from '@meza/core';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { getInfoAsync, readAsStringAsync } from 'expo-file-system';

export interface PickedFile {
  uri: string;
  name: string;
  type: string;
  size: number;
}

/**
 * Pick an image from the library or camera.
 */
export async function pickImage(
  source: 'library' | 'camera' = 'library',
): Promise<PickedFile | null> {
  const permResult =
    source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();

  if (!permResult.granted) return null;

  const result =
    source === 'camera'
      ? await ImagePicker.launchCameraAsync({
          quality: 0.8,
          allowsEditing: false,
        })
      : await ImagePicker.launchImageLibraryAsync({
          quality: 0.8,
          allowsEditing: false,
        });

  if (result.canceled || !result.assets[0]) return null;

  const asset = result.assets[0];
  const filename = asset.uri.split('/').pop() ?? 'image.jpg';
  const mimeType = asset.mimeType ?? 'image/jpeg';

  // Get file info for size
  const info = await getInfoAsync(asset.uri);
  const size = info.exists ? (info.size ?? 0) : 0;

  return { uri: asset.uri, name: filename, type: mimeType, size };
}

/**
 * Pick a document/file.
 */
export async function pickDocument(): Promise<PickedFile | null> {
  const result = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
  });

  if (result.canceled || !result.assets[0]) return null;

  const asset = result.assets[0];
  return {
    uri: asset.uri,
    name: asset.name,
    type: asset.mimeType ?? 'application/octet-stream',
    size: asset.size ?? 0,
  };
}

/**
 * Read file bytes from a local URI.
 */
async function readFileBytes(uri: string): Promise<Uint8Array> {
  const base64 = await readAsStringAsync(uri, {
    encoding: 'base64',
  });
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encrypt and upload a picked file as a chat attachment.
 *
 * Mobile equivalent of core's uploadEncryptedFile, without DOM File/Blob.
 */
export async function uploadEncryptedFileMobile(
  file: PickedFile,
  channelId: string,
  onProgress?: (percent: number) => void,
): Promise<EncryptedUploadResult> {
  // 1. Read file bytes
  onProgress?.(5);
  const fileBytes = await readFileBytes(file.uri);

  // 2. Generate per-file key
  const fileKey = generateFileKey();

  // 3. Encrypt file
  onProgress?.(15);
  const encryptedFile = await encryptFile(fileKey, fileBytes);

  // 4. Wrap file key with channel key
  const encryptedKey = await wrapFileKey(channelId, fileKey);

  // 5. CreateUpload
  onProgress?.(25);
  const { uploadId, uploadUrl } = await createUpload(
    file.name,
    'application/octet-stream',
    encryptedFile.length,
    UploadPurpose.CHAT_ATTACHMENT,
    file.type,
  );

  // 6. Upload encrypted file via fetch PUT
  onProgress?.(30);
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: encryptedFile.buffer.slice(
      encryptedFile.byteOffset,
      encryptedFile.byteOffset + encryptedFile.byteLength,
    ) as ArrayBuffer,
  });
  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status}`);
  }
  onProgress?.(90);

  // 7. CompleteUpload
  const result = await completeUpload(uploadId, {
    encryptedKey,
  });
  onProgress?.(100);

  return {
    attachmentId: result.attachmentId,
    width: result.width,
    height: result.height,
    microThumbnail: result.microThumbnail,
    filename: file.name,
    contentType: file.type,
    sizeBytes: file.size,
  };
}

/**
 * Download and decrypt an encrypted attachment.
 * Returns decrypted bytes.
 */
export async function downloadAndDecryptAttachment(
  channelId: string,
  attachmentId: string,
  encryptedKey: Uint8Array,
): Promise<Uint8Array> {
  // 1. Unwrap the file key
  const fileKey = await unwrapFileKey(channelId, encryptedKey);

  // 2. Fetch encrypted bytes
  const encryptedBytes = await fetchEncryptedMedia(attachmentId);

  // 3. Decrypt
  return decryptFile(fileKey, encryptedBytes);
}
