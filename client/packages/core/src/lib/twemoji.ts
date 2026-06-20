/**
 * Twemoji SVG URL utilities.
 *
 * Converts Unicode emoji characters to Twemoji SVG filenames.
 * Handles ZWJ sequences, skin tones, flags, keycaps, and the
 * FE0F (variant selector) stripping rule:
 *
 *  - If ZWJ (U+200D) is present → keep all FE0F in the filename
 *  - If no ZWJ → strip all FE0F from the filename
 */

/**
 * Convert a Unicode emoji string to its Twemoji SVG filename.
 *
 * @example
 * charToTwemojiFilename('😀')     // '1f600.svg'
 * charToTwemojiFilename('❤️')      // '2764.svg'        (FE0F stripped, no ZWJ)
 * charToTwemojiFilename('👋🏿')     // '1f44b-1f3ff.svg' (skin tone)
 * charToTwemojiFilename('❤️‍🔥')   // '2764-fe0f-200d-1f525.svg' (FE0F kept, has ZWJ)
 */
export function charToTwemojiFilename(emoji: string): string {
  const codepoints: string[] = [];
  for (const char of emoji) {
    const cp = char.codePointAt(0);
    if (cp !== undefined) {
      codepoints.push(cp.toString(16));
    }
  }

  const joined = codepoints.join('-');
  const hasZwj = joined.includes('200d');

  if (hasZwj) {
    return `${joined}.svg`;
  }
  return `${joined.replace(/-fe0f/g, '')}.svg`;
}

/**
 * Build the URL for a Twemoji SVG from a Unicode emoji character.
 * Uses import.meta.env.BASE_URL so it works across web ('/') and
 * desktop ('./') builds.
 */
export function getTwemojiUrl(emoji: string): string {
  return `${import.meta.env.BASE_URL}twemoji/${charToTwemojiFilename(emoji)}`;
}
