import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import stripMarkdownPlugin from 'strip-markdown';

const processor = remark().use(remarkGfm).use(stripMarkdownPlugin);

const SPOILER_STRIP_REGEX = /\|\|.+?\|\|/g;

/**
 * Strip markdown formatting from a string, returning plain text.
 * Used for preview contexts (reply bars, pinned message snippets).
 * Spoiler content is replaced with [spoiler] to avoid leaking hidden text.
 */
export function stripMarkdown(text: string): string {
  const sanitized = text.replace(SPOILER_STRIP_REGEX, '[spoiler]');
  const result = processor.processSync(sanitized);
  return String(result).trim();
}
