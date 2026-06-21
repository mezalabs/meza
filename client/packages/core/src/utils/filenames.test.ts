import { describe, expect, it } from 'vitest';
import { sanitizeFilename } from './filenames.ts';

describe('sanitizeFilename', () => {
  it('leaves ordinary filenames untouched', () => {
    expect(sanitizeFilename('report.pdf')).toBe('report.pdf');
    expect(sanitizeFilename('My Photo 2026.jpeg')).toBe('My Photo 2026.jpeg');
    expect(sanitizeFilename('archive.tar.gz')).toBe('archive.tar.gz');
  });

  it('strips the RTL-override extension-spoofing trick', () => {
    // "invoice<U+202E>fdp.exe" renders as "invoicexe.pdf" but is really .exe
    const spoofed = `invoice${String.fromCharCode(0x202e)}fdp.exe`;
    expect(sanitizeFilename(spoofed)).toBe('invoicefdp.exe');
  });

  it('strips zero-width, isolate, and C0/C1 control characters', () => {
    const nasty = [
      'a',
      String.fromCharCode(0x200b), // zero-width space
      'b',
      String.fromCharCode(0x2066), // LTR isolate
      'c',
      String.fromCharCode(0x07), // bell (C0)
      String.fromCharCode(0x9f), // C1
      String.fromCharCode(0xad), // soft hyphen
      '.txt',
    ].join('');
    expect(sanitizeFilename(nasty)).toBe('abc.txt');
  });

  it('falls back to a non-empty name when nothing survives', () => {
    expect(sanitizeFilename(String.fromCharCode(0x202e, 0x200b))).toBe('file');
    expect(sanitizeFilename('   ')).toBe('file');
  });

  it('caps length while preserving a short extension', () => {
    const long = `${'a'.repeat(400)}.png`;
    const out = sanitizeFilename(long);
    expect(out.length).toBe(255);
    expect(out.endsWith('.png')).toBe(true);
  });

  it('caps length when there is no usable extension', () => {
    const out = sanitizeFilename('z'.repeat(400));
    expect(out.length).toBe(255);
  });
});
