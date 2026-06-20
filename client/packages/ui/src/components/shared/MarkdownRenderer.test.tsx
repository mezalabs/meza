import { describe, expect, it } from 'vitest';
import { countOccurrences, renderMarkdown } from './markdownTestUtils.tsx';

/**
 * Behavioral contract for how MarkdownRenderer renders text.
 *
 * The visible numbers in an ordered list are produced by the browser/CSS
 * counter, not by literal text in the HTML. So these tests assert on the
 * structure the renderer emits: the `start` attribute on <ol> (which seeds the
 * counter) and the number of <li> items. From those two facts the visible
 * numbering is fully determined.
 */
describe('MarkdownRenderer ordered lists', () => {
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

describe('MarkdownRenderer non-list text', () => {
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

describe('MarkdownRenderer unordered & task lists', () => {
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

describe('MarkdownRenderer nested ordered lists', () => {
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

describe('MarkdownRenderer inline formatting inside list items', () => {
  it('renders emphasis, code, and links inside an ordered list item', () => {
    const html = renderMarkdown('1. **bold** `code` [link](https://x.com)');
    expect(html).not.toContain('start='); // list starts at 1, so omitted
    expect(html).toContain('<li');
    expect(html).toContain('<strong>');
    expect(html).toContain('<code');
    expect(html).toContain('href="https://x.com"');
  });
});

/**
 * Broad spec coverage. These assert the structural + sanitization contract of
 * the pipeline (remark-gfm, remark-breaks, MEZA sanitize schema) so a future
 * change to list rendering — or the shared schema — can't silently regress
 * unrelated markdown features.
 */
describe('MarkdownRenderer markdown spec', () => {
  it('renders headings h1–h6', () => {
    const html = renderMarkdown('# h1\n\n## h2\n\n###### h6');
    expect(html).toContain('<h1>');
    expect(html).toContain('<h2>');
    expect(html).toContain('<h6>');
  });

  it('renders emphasis and strong', () => {
    const html = renderMarkdown('*em* and **strong**');
    expect(html).toContain('<em>');
    expect(html).toContain('<strong>');
  });

  it('renders inline code and fenced code blocks', () => {
    expect(renderMarkdown('`inline`')).toContain('<code');
    const block = renderMarkdown('```\nblock\n```');
    expect(block).toContain('<pre');
    expect(block).toContain('<code');
  });

  it('renders blockquotes', () => {
    expect(renderMarkdown('> quoted')).toContain('<blockquote');
  });

  it('renders horizontal rules', () => {
    expect(renderMarkdown('a\n\n---\n\nb')).toContain('<hr');
  });

  it('renders GFM tables', () => {
    const html = renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(html).toContain('<td');
  });

  it('renders GFM strikethrough', () => {
    expect(renderMarkdown('~~gone~~')).toContain('<del>');
  });

  it('converts a single newline to a line break (remark-breaks)', () => {
    expect(renderMarkdown('line one\nline two')).toContain('<br');
  });

  it('renders links with their href preserved', () => {
    expect(renderMarkdown('[text](https://example.com)')).toContain(
      'href="https://example.com"',
    );
  });
});

/**
 * Sanitization is shared across every element via MEZA_SANITIZE_SCHEMA. A list
 * refactor shouldn't touch it, but these lock the security contract in place.
 */
describe('MarkdownRenderer sanitization', () => {
  it('never emits an executable <script> tag', () => {
    // Raw HTML isn't parsed (no rehype-raw), so the tag is dropped entirely.
    // The inner text may survive but only as inert, escaped text in a <p>.
    const html = renderMarkdown('hi <script>alert(1)</script> there');
    expect(html).not.toContain('<script');
  });

  it('drops dangerous link protocols', () => {
    const html = renderMarkdown('[x](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
  });

  it('drops event-handler attributes from raw HTML', () => {
    const html = renderMarkdown(
      '<img src="https://x.com/a.png" onerror="x()">',
    );
    expect(html).not.toContain('onerror');
  });
});
