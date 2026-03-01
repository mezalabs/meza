import type { Root } from 'mdast';
import { remark } from 'remark';
import { describe, expect, it } from 'vitest';
import { remarkMezaSpoiler } from './remarkMezaSpoiler.ts';

/** Run the spoiler plugin and return the MDAST tree. */
function parse(input: string): Root {
  const processor = remark().use(remarkMezaSpoiler);
  return processor.runSync(processor.parse(input)) as Root;
}

/** Extract node types from a paragraph's children. */
function childTypes(tree: Root) {
  const paragraph = tree.children[0];
  if (paragraph.type !== 'paragraph') return [];
  return (paragraph as { children: { type: string }[] }).children.map(
    (c) => c.type,
  );
}

/** Extract spoiler values from a paragraph's children. */
function spoilerValues(tree: Root) {
  const paragraph = tree.children[0];
  if (paragraph.type !== 'paragraph') return [];
  return (
    paragraph as {
      children: { type: string; data?: { hChildren?: { value: string }[] } }[];
    }
  ).children
    .filter((c) => c.type === 'mezaSpoiler')
    .map((c) => c.data?.hChildren?.[0]?.value);
}

describe('remarkMezaSpoiler', () => {
  it('parses a single spoiler', () => {
    const tree = parse('||hidden text||');
    expect(childTypes(tree)).toEqual(['mezaSpoiler']);
    expect(spoilerValues(tree)).toEqual(['hidden text']);
  });

  it('preserves surrounding text', () => {
    const tree = parse('before ||secret|| after');
    expect(childTypes(tree)).toEqual(['text', 'mezaSpoiler', 'text']);
    expect(spoilerValues(tree)).toEqual(['secret']);
  });

  it('handles multiple spoilers in one line', () => {
    const tree = parse('||one|| and ||two||');
    expect(childTypes(tree)).toEqual(['mezaSpoiler', 'text', 'mezaSpoiler']);
    expect(spoilerValues(tree)).toEqual(['one', 'two']);
  });

  it('handles adjacent spoilers', () => {
    const tree = parse('||one||||two||');
    expect(spoilerValues(tree)).toEqual(['one', 'two']);
  });

  it('does not match empty spoilers (||||)', () => {
    const tree = parse('||||');
    // .+? requires at least 1 character, so |||| should not produce a spoiler node
    expect(childTypes(tree)).toEqual(['text']);
  });

  it('handles spoilers with pipes inside', () => {
    const tree = parse('||foo | bar||');
    expect(spoilerValues(tree)).toEqual(['foo | bar']);
  });

  it('does not match unclosed spoilers', () => {
    const tree = parse('||unclosed text');
    expect(childTypes(tree)).toEqual(['text']);
  });

  it('does not match single pipes', () => {
    const tree = parse('a | b');
    expect(childTypes(tree)).toEqual(['text']);
  });

  it('does not cross paragraph boundaries', () => {
    const tree = parse('||start\n\nend||');
    // Two paragraphs — the spoiler syntax should not match across them
    expect(tree.children).toHaveLength(2);
  });

  it('produces correct hName for the custom element', () => {
    const tree = parse('||test||');
    const paragraph = tree.children[0] as {
      children: { data?: { hName?: string } }[];
    };
    expect(paragraph.children[0].data?.hName).toBe('meza-spoiler');
  });

  it('handles text with no spoilers unchanged', () => {
    const tree = parse('just normal text');
    expect(childTypes(tree)).toEqual(['text']);
  });
});
