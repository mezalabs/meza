// Filename hygiene for attachments.
//
// Attachment filenames travel inside the E2EE message payload (the `fn` field),
// so the server never sees or sanitizes them. A malicious sender can therefore
// embed bidirectional-override or other control characters to make a dangerous
// name render deceptively (e.g. a U+202E override can make a ".exe" appear to
// end in ".pdf"). Strip those characters wherever a filename is displayed or
// written to disk so the user always sees the real name.

const MAX_FILENAME_LENGTH = 255;

// C0/DEL/C1 control chars, soft hyphen, zero-width + directional formatting,
// and the LTR/RTL isolate controls. None of these belong in a filename.
// Constructed from a string (with escape sequences) so the source file carries
// no literal control characters — a regex literal here would embed them.
// biome-ignore lint/complexity/useRegexLiterals: literal form would inline control chars into source
const UNSAFE_CHARS = new RegExp(
  '[\\u0000-\\u001F\\u007F-\\u009F\\u00AD\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069]',
  'g',
);

/**
 * Remove control/bidi characters from a filename and bound its length, keeping
 * the extension intact when truncating. Returns a non-empty fallback when the
 * name reduces to nothing.
 */
export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(UNSAFE_CHARS, '').trim();
  if (cleaned.length === 0) return 'file';
  if (cleaned.length <= MAX_FILENAME_LENGTH) return cleaned;

  // Preserve a short trailing extension so the truncated name stays meaningful.
  const dot = cleaned.lastIndexOf('.');
  if (dot > 0 && cleaned.length - dot <= 16) {
    const ext = cleaned.slice(dot);
    return cleaned.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
  }
  return cleaned.slice(0, MAX_FILENAME_LENGTH);
}
