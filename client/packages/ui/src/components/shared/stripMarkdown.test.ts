import { describe, expect, it } from 'vitest';
import { stripMarkdown } from './stripMarkdown.ts';

describe('stripMarkdown', () => {
  it('strips basic markdown formatting', () => {
    expect(stripMarkdown('**bold** text')).toBe('bold text');
  });

  it('replaces spoiler content with [spoiler]', () => {
    expect(stripMarkdown('||secret text||')).toBe('\\[spoiler]');
  });

  it('replaces spoiler but preserves surrounding text', () => {
    expect(stripMarkdown('before ||hidden|| after')).toBe(
      'before \\[spoiler] after',
    );
  });

  it('replaces multiple spoilers', () => {
    expect(stripMarkdown('||one|| and ||two||')).toBe(
      '\\[spoiler] and \\[spoiler]',
    );
  });

  it('replaces spoiler with markdown inside', () => {
    expect(stripMarkdown('||**bold** text||')).toBe('\\[spoiler]');
  });

  it('does not replace unclosed spoiler markers', () => {
    expect(stripMarkdown('||unclosed')).toBe('||unclosed');
  });

  it('does not match empty spoilers (||||)', () => {
    // .+? requires at least one character
    expect(stripMarkdown('||||')).toBe('||||');
  });

  it('does not match multiline spoilers (no dotAll)', () => {
    // The s flag was intentionally removed — spoilers must be single-line
    const result = stripMarkdown('||line1\nline2||');
    expect(result).not.toContain('[spoiler]');
  });
});
