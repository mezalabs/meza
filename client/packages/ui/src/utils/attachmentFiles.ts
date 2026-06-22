// Pure helpers for turning OS drag-drop / clipboard payloads into File lists and
// for deciding which files the composer can accept. Kept free of React/DOM
// component dependencies so they can be unit-tested directly.

export interface ExtractedFiles {
  files: File[];
  /** A directory was part of the drop (folders are not supported). */
  hadFolder: boolean;
}

/**
 * Pull plain files out of a drop `DataTransfer`, synchronously. Directories are
 * detected via `webkitGetAsEntry()` and excluded (recursive folder upload is out
 * of scope); their presence is reported via `hadFolder` so the caller can warn.
 *
 * Must be called synchronously inside the `drop` handler — the `DataTransfer` and
 * its `items` are neutered once the handler returns.
 */
export function extractDroppedFiles(dt: DataTransfer | null): ExtractedFiles {
  if (!dt) return { files: [], hadFolder: false };

  const items = dt.items ? Array.from(dt.items) : [];
  if (items.length > 0) {
    const files: File[] = [];
    let hadFolder = false;
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry?.isDirectory) {
        hadFolder = true;
        continue;
      }
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    return { files, hadFolder };
  }

  return { files: Array.from(dt.files), hadFolder: false };
}

/**
 * Pull pasted files (e.g. screenshots) out of a clipboard `DataTransfer`.
 * Only real `file`-kind items are returned — text/HTML is deliberately ignored
 * here so the caller can fall through to the plain-text paste path (which is what
 * preserves the composer's anti-HTML-injection guarantee).
 */
export function filesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];

  const fromItems: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) fromItems.push(file);
    }
  }
  if (fromItems.length > 0) return fromItems;

  // Firefox populates `files` directly for image paste rather than `items`.
  return Array.from(data.files ?? []);
}

export interface FilePartition {
  accepted: File[];
  /** Names of files rejected for exceeding the per-file size limit. */
  rejectedTooLarge: string[];
  /** Count of files rejected because the per-message count cap was reached. */
  rejectedOverCount: number;
}

/**
 * Split incoming files into accepted vs rejected, in a single pass so attribution
 * is deterministic. The count cap takes precedence over the size check: once the
 * remaining slots are full, every further file counts as over-count (even if it
 * would also be over-size).
 */
export function partitionFiles(
  files: File[],
  remainingSlots: number,
  maxSize: number,
): FilePartition {
  const accepted: File[] = [];
  const rejectedTooLarge: string[] = [];
  let rejectedOverCount = 0;

  for (const file of files) {
    if (accepted.length >= remainingSlots) {
      rejectedOverCount++;
      continue;
    }
    if (file.size > maxSize) {
      rejectedTooLarge.push(file.name);
      continue;
    }
    accepted.push(file);
  }

  return { accepted, rejectedTooLarge, rejectedOverCount };
}
