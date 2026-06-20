import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { describe, expect, it } from 'vitest';
import { markdownListComponents } from './markdownListComponents.tsx';

/**
 * Render markdown to a static HTML string using the *production* list handlers
 * (`markdownListComponents`) plus the structural remark plugins that govern how
 * lists parse: remark-gfm (ordered/unordered/task lists) and remark-breaks
 * (line handling). That's exactly the slice of MarkdownRenderer's pipeline this
 * module owns.
 *
 * It deliberately does NOT wire up sanitization, syntax highlighting, or the
 * custom Meza element plugins. Those are independent concerns covered elsewhere,
 * and folding them in here would turn this helper into a second, drifting copy
 * of the production pipeline (the very thing that made the old broad "spec" and
 * "sanitization" suites assert third-party defaults rather than Meza behavior).
 *
 * The visible ordered-list numbers come from the CSS counter seeded by the
 * `<ol start>` attribute, not from literal text — so the assertions target the
 * `start` attribute and the <li> count, from which the numbering is determined.
 */
function renderMarkdown(content: string): string {
  return renderToStaticMarkup(
    <Markdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      components={markdownListComponents}
    >
      {content}
    </Markdown>,
  );
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  return needle ? haystack.split(needle).length - 1 : 0;
}

describe('markdownListComponents ordered lists', () => {
  const countListItems = (html: string) => countOccurrences(html, '<li');

  it('preserves the author-typed starting number (regression: "4." became "1.")', () => {
    // A lone "4. ..." line — someone referencing item 4 of a list elsewhere.
    const html = renderMarkdown('4. is a really good point');
    expect(html).toContain('<ol');
    expect(html).toContain('start="4"');
    expect(countListItems(html)).toBe(1);
  });

  it('omits the start attribute for a normal list beginning at 1', () => {
    const html = renderMarkdown('1. first\n2. second');
    expect(html).toContain('<ol');
    // No explicit start → browser counts from 1.
    expect(html).not.toContain('start=');
    expect(countListItems(html)).toBe(2);
  });

  it('auto-increments instead of repeating when every item is "1."', () => {
    // Only the first marker matters; items render 1, 2, 3 via the counter.
    const html = renderMarkdown('1. a\n1. b\n1. c');
    expect(html).not.toContain('start=');
    expect(countListItems(html)).toBe(3);
    // The repeated "1." markers are not emitted as literal text/values.
    expect(html).not.toContain('value=');
  });

  it('seeds the counter from the first marker, then ignores later numbers', () => {
    // "5." then "5." then "5." → renders 5, 6, 7.
    const html = renderMarkdown('5. a\n5. b\n5. c');
    expect(html).toContain('start="5"');
    expect(countListItems(html)).toBe(3);
    expect(html).not.toContain('value=');
  });

  it('uses only the first number even when later numbers are arbitrary', () => {
    // "1." then "7." then "3." → renders 1, 2, 3 (first marker wins).
    const html = renderMarkdown('1. a\n7. b\n3. c');
    expect(html).not.toContain('start=');
    expect(countListItems(html)).toBe(3);
  });
});

describe('markdownListComponents non-list text', () => {
  it('does not turn a number without a list marker into a list', () => {
    const html = renderMarkdown('4 is a really good point');
    expect(html).not.toContain('<ol');
    expect(html).not.toContain('<li');
  });

  it('renders plain prose without any list markup', () => {
    const html = renderMarkdown('just some words here');
    expect(html).not.toContain('<ol');
    expect(html).not.toContain('<ul');
  });
});

describe('markdownListComponents unordered & task lists', () => {
  const countListItems = (html: string) => countOccurrences(html, '<li');

  it('renders an unordered list with the disc class', () => {
    const html = renderMarkdown('- a\n- b\n- c');
    expect(html).toContain('<ul');
    expect(html).toContain('list-disc');
    expect(html).not.toContain('<ol');
    expect(countListItems(html)).toBe(3);
  });

  it('renders task lists with checkboxes (regression: li dropped extra props)', () => {
    const html = renderMarkdown('- [ ] todo\n- [x] done');
    // The checkbox <input> lives in the li's children, so it must survive even
    // though the li handler no longer spreads arbitrary props.
    expect(countOccurrences(html, 'type="checkbox"')).toBe(2);
    expect(html).toContain('checked'); // the [x] item
    // Task items get the special flex/list-none layout from the li handler.
    expect(html).toContain('list-none');
  });

  it('preserves nesting of unordered lists', () => {
    const html = renderMarkdown('- a\n  - b\n- c');
    expect(countOccurrences(html, '<ul')).toBe(2);
    expect(countListItems(html)).toBe(3);
  });
});

describe('markdownListComponents nested ordered lists', () => {
  it('keeps an independent counter per nesting level', () => {
    const html = renderMarkdown('1. a\n   1. b\n2. c');
    // Two <ol>s (outer + nested), neither needs an explicit start (both at 1).
    expect(countOccurrences(html, '<ol')).toBe(2);
    expect(html).not.toContain('start=');
    expect(countOccurrences(html, '<li')).toBe(3);
  });

  it('preserves the start number on a nested ordered list', () => {
    // Blank line is required: an ordered list starting at ≠1 can't interrupt
    // the "outer" paragraph (the same CommonMark rule behind the "4."→"1." bug).
    const html = renderMarkdown('1. outer\n\n   3. nested-a\n   3. nested-b');
    expect(countOccurrences(html, '<ol')).toBe(2);
    expect(html).toContain('start="3"');
  });
});

describe('markdownListComponents inline formatting inside list items', () => {
  it('renders emphasis, code, and links inside an ordered list item', () => {
    const html = renderMarkdown('1. **bold** `code` [link](https://x.com)');
    expect(html).not.toContain('start='); // list starts at 1, so omitted
    expect(html).toContain('<li');
    expect(html).toContain('<strong>');
    expect(html).toContain('<code');
    expect(html).toContain('href="https://x.com"');
  });
});
