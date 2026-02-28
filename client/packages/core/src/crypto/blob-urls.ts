/**
 * Reference-counted blob URL manager for decrypted media.
 *
 * Prevents memory leaks by tracking references to each blob URL.
 * When the last reference is released, the blob URL is revoked.
 *
 * Usage:
 *   const url = acquireBlobURL('attachment-123', decryptedBlob);
 *   // ... use url in <img> or <video> ...
 *   releaseBlobURL('attachment-123');
 */

interface BlobEntry {
  url: string;
  refCount: number;
}

const blobMap = new Map<string, BlobEntry>();

/**
 * Acquire a blob URL for a key. Creates a new URL on first call,
 * increments the reference count on subsequent calls.
 */
export function acquireBlobURL(key: string, blob: Blob): string {
  const existing = blobMap.get(key);
  if (existing) {
    existing.refCount++;
    return existing.url;
  }
  const url = URL.createObjectURL(blob);
  blobMap.set(key, { url, refCount: 1 });
  return url;
}

/**
 * Release a reference to a blob URL. Revokes when the count reaches zero.
 */
export function releaseBlobURL(key: string): void {
  const entry = blobMap.get(key);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount <= 0) {
    URL.revokeObjectURL(entry.url);
    blobMap.delete(key);
  }
}

/**
 * Revoke all managed blob URLs. Call on logout or session teardown.
 */
export function releaseAllBlobURLs(): void {
  for (const entry of blobMap.values()) {
    URL.revokeObjectURL(entry.url);
  }
  blobMap.clear();
}
