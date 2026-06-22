import { describe, expect, it } from 'vitest';
import {
  extractDroppedFiles,
  filesFromClipboard,
  partitionFiles,
} from './attachmentFiles.ts';

// Lightweight stand-ins — the helpers only read .name / .size / .kind etc.
function mockFile(name: string, size = 1): File {
  return { name, size } as unknown as File;
}
function fileItem(file: File | null, isDirectory = false): DataTransferItem {
  return {
    kind: 'file',
    getAsFile: () => file,
    webkitGetAsEntry: () => (file || isDirectory ? { isDirectory } : null),
  } as unknown as DataTransferItem;
}
function stringItem(): DataTransferItem {
  return {
    kind: 'string',
    getAsFile: () => null,
    webkitGetAsEntry: () => null,
  } as unknown as DataTransferItem;
}
function mockDataTransfer(
  items: DataTransferItem[] | null,
  files: File[] = [],
): DataTransfer {
  return { items, files } as unknown as DataTransfer;
}

describe('extractDroppedFiles', () => {
  it('returns files from items, skipping non-file items', () => {
    const a = mockFile('a.png');
    const b = mockFile('b.pdf');
    const dt = mockDataTransfer([fileItem(a), stringItem(), fileItem(b)]);
    expect(extractDroppedFiles(dt)).toEqual({
      files: [a, b],
      hadFolder: false,
    });
  });

  it('flags folders and excludes them', () => {
    const file = mockFile('doc.txt');
    const dt = mockDataTransfer([fileItem(null, true), fileItem(file)]);
    const result = extractDroppedFiles(dt);
    expect(result.files).toEqual([file]);
    expect(result.hadFolder).toBe(true);
  });

  it('falls back to .files when items are absent', () => {
    const a = mockFile('x.jpg');
    const dt = mockDataTransfer(null, [a]);
    expect(extractDroppedFiles(dt)).toEqual({ files: [a], hadFolder: false });
  });

  it('handles a null DataTransfer', () => {
    expect(extractDroppedFiles(null)).toEqual({ files: [], hadFolder: false });
  });
});

describe('filesFromClipboard', () => {
  it('returns only file-kind items (ignores text/html for injection safety)', () => {
    const img = mockFile('screenshot.png');
    const dt = mockDataTransfer([stringItem(), fileItem(img)]);
    expect(filesFromClipboard(dt)).toEqual([img]);
  });

  it('returns empty when only text is present (so caller falls through to text paste)', () => {
    const dt = mockDataTransfer([stringItem()]);
    expect(filesFromClipboard(dt)).toEqual([]);
  });

  it('falls back to .files (Firefox image paste)', () => {
    const img = mockFile('pasted.png');
    const dt = mockDataTransfer([], [img]);
    expect(filesFromClipboard(dt)).toEqual([img]);
  });
});

describe('partitionFiles', () => {
  const MAX = 50;

  it('accepts everything that fits', () => {
    const files = [mockFile('a', 1), mockFile('b', 2)];
    const r = partitionFiles(files, 10, MAX);
    expect(r.accepted).toHaveLength(2);
    expect(r.rejectedTooLarge).toEqual([]);
    expect(r.rejectedOverCount).toBe(0);
  });

  it('rejects oversize files by name', () => {
    const files = [mockFile('ok', 1), mockFile('huge.mov', 999)];
    const r = partitionFiles(files, 10, MAX);
    expect(r.accepted.map((f) => f.name)).toEqual(['ok']);
    expect(r.rejectedTooLarge).toEqual(['huge.mov']);
  });

  it('enforces the remaining-slots cap, attributing the overflow to count', () => {
    const files = [mockFile('a'), mockFile('b'), mockFile('c')];
    const r = partitionFiles(files, 2, MAX);
    expect(r.accepted).toHaveLength(2);
    expect(r.rejectedOverCount).toBe(1);
    expect(r.rejectedTooLarge).toEqual([]);
  });

  it('counts files past the cap as over-count even if also oversize', () => {
    const files = [mockFile('a', 1), mockFile('b', 1), mockFile('big', 999)];
    const r = partitionFiles(files, 2, MAX);
    expect(r.accepted).toHaveLength(2);
    expect(r.rejectedOverCount).toBe(1);
    expect(r.rejectedTooLarge).toEqual([]);
  });

  it('rejects all when no slots remain', () => {
    const r = partitionFiles([mockFile('a'), mockFile('b')], 0, MAX);
    expect(r.accepted).toEqual([]);
    expect(r.rejectedOverCount).toBe(2);
  });
});
