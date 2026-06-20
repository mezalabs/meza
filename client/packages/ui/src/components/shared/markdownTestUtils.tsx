import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { markdownListComponents } from './markdownListComponents.tsx';
import { MEZA_SANITIZE_SCHEMA } from './markdownSanitizeSchema.ts';

/**
 * Render markdown to a static HTML string for assertions in tests.
 *
 * Mirrors MarkdownRenderer's pipeline for the pieces that determine text
 * rendering — the remark-gfm + remark-breaks parsing, the MEZA sanitize schema,
 * and the shared list handlers (markdownListComponents) — without dragging in
 * app stores. The list handlers are the *same* objects production uses, so a
 * regression in them is caught here.
 *
 * Note: elements without a custom handler (headings, links, code, tables, …)
 * render as react-markdown's default HTML elements here. That's intentional —
 * those handlers only add CSS classes and aren't what this suite guards. These
 * tests cover the structural/sanitization contract (what nodes are produced and
 * which are stripped), which is exactly what a list refactor could regress.
 */
export function renderMarkdown(content: string): string {
  return renderToStaticMarkup(
    <Markdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      rehypePlugins={[[rehypeSanitize, MEZA_SANITIZE_SCHEMA]]}
      components={markdownListComponents}
    >
      {content}
    </Markdown>,
  );
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}
