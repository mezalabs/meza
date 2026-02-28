import { describe, expect, it } from 'vitest';
import {
  allPaneIds,
  findPane,
  paneCount,
  removePane,
  splitPane,
  updateRatio,
} from './tree.ts';
import type { PaneLeaf, PaneSplit, TilingNode } from './types.ts';

const leaf = (id: string): PaneLeaf => ({ type: 'pane', id });

const split = (
  direction: 'horizontal' | 'vertical',
  first: TilingNode,
  second: TilingNode,
  ratio = 0.5,
): PaneSplit => ({
  type: 'split',
  direction,
  ratio,
  first,
  second,
});

describe('splitPane', () => {
  it('splits a single pane into two', () => {
    const root = leaf('a');
    const result = splitPane(root, 'a', 'horizontal', 'b');

    expect(result).toEqual(split('horizontal', leaf('a'), leaf('b')));
  });

  it('does nothing if target pane is not found', () => {
    const root = leaf('a');
    const result = splitPane(root, 'nonexistent', 'vertical', 'b');
    expect(result).toEqual(root);
  });

  it('splits a nested pane correctly', () => {
    const root = split('horizontal', leaf('a'), leaf('b'));
    const result = splitPane(root, 'b', 'vertical', 'c');

    expect(result).toEqual(
      split('horizontal', leaf('a'), split('vertical', leaf('b'), leaf('c'))),
    );
  });

  it('splits deeply nested pane', () => {
    const root = split(
      'horizontal',
      leaf('a'),
      split('vertical', leaf('b'), leaf('c')),
    );
    const result = splitPane(root, 'c', 'horizontal', 'd');

    expect(result.type).toBe('split');
    expect(paneCount(result)).toBe(4);
    expect(allPaneIds(result)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('removePane', () => {
  it('returns null when removing the only pane', () => {
    const result = removePane(leaf('a'), 'a');
    expect(result).toBeNull();
  });

  it('does not remove non-matching single pane', () => {
    const result = removePane(leaf('a'), 'b');
    expect(result).toEqual(leaf('a'));
  });

  it('promotes sibling when removing first child', () => {
    const root = split('horizontal', leaf('a'), leaf('b'));
    const result = removePane(root, 'a');
    expect(result).toEqual(leaf('b'));
  });

  it('promotes sibling when removing second child', () => {
    const root = split('horizontal', leaf('a'), leaf('b'));
    const result = removePane(root, 'b');
    expect(result).toEqual(leaf('a'));
  });

  it('promotes subtree when removing from nested split', () => {
    const root = split(
      'horizontal',
      leaf('a'),
      split('vertical', leaf('b'), leaf('c')),
    );
    const result = removePane(root, 'b');

    // b removed from inner split → c promoted → outer split is now [a, c]
    expect(result).toEqual(split('horizontal', leaf('a'), leaf('c')));
  });

  it('handles deep removal', () => {
    const root = split(
      'horizontal',
      split('vertical', leaf('a'), leaf('b')),
      split('vertical', leaf('c'), leaf('d')),
    );
    const result = removePane(root, 'c');

    expect(result).toEqual(
      split('horizontal', split('vertical', leaf('a'), leaf('b')), leaf('d')),
    );
  });
});

describe('updateRatio', () => {
  it('updates ratio at root split', () => {
    const root = split('horizontal', leaf('a'), leaf('b'));
    const result = updateRatio(root, [], 0.7);

    expect(result.type).toBe('split');
    expect((result as PaneSplit).ratio).toBe(0.7);
  });

  it('clamps ratio to minimum 0.1', () => {
    const root = split('horizontal', leaf('a'), leaf('b'));
    const result = updateRatio(root, [], 0.02);
    expect((result as PaneSplit).ratio).toBe(0.1);
  });

  it('clamps ratio to maximum 0.9', () => {
    const root = split('horizontal', leaf('a'), leaf('b'));
    const result = updateRatio(root, [], 0.99);
    expect((result as PaneSplit).ratio).toBe(0.9);
  });

  it('updates nested split ratio', () => {
    const root = split(
      'horizontal',
      leaf('a'),
      split('vertical', leaf('b'), leaf('c')),
    );
    const result = updateRatio(root, ['second'], 0.3);

    const innerSplit = (result as PaneSplit).second as PaneSplit;
    expect(innerSplit.ratio).toBe(0.3);
  });

  it('does nothing when updating ratio on a pane node', () => {
    const root = leaf('a');
    const result = updateRatio(root, [], 0.5);
    expect(result).toEqual(leaf('a'));
  });
});

describe('allPaneIds', () => {
  it('returns single pane id', () => {
    expect(allPaneIds(leaf('a'))).toEqual(['a']);
  });

  it('returns ids in order for a split', () => {
    const root = split('horizontal', leaf('a'), leaf('b'));
    expect(allPaneIds(root)).toEqual(['a', 'b']);
  });

  it('returns ids in order for nested splits', () => {
    const root = split(
      'horizontal',
      split('vertical', leaf('a'), leaf('b')),
      split('vertical', leaf('c'), leaf('d')),
    );
    expect(allPaneIds(root)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('findPane', () => {
  it('finds root pane', () => {
    expect(findPane(leaf('a'), 'a')).toEqual([]);
  });

  it('returns null for missing pane', () => {
    expect(findPane(leaf('a'), 'b')).toBeNull();
  });

  it('finds pane in first child', () => {
    const root = split('horizontal', leaf('a'), leaf('b'));
    expect(findPane(root, 'a')).toEqual(['first']);
  });

  it('finds pane in second child', () => {
    const root = split('horizontal', leaf('a'), leaf('b'));
    expect(findPane(root, 'b')).toEqual(['second']);
  });

  it('finds deeply nested pane', () => {
    const root = split(
      'horizontal',
      leaf('a'),
      split('vertical', leaf('b'), leaf('c')),
    );
    expect(findPane(root, 'c')).toEqual(['second', 'second']);
  });
});

describe('paneCount', () => {
  it('counts single pane', () => {
    expect(paneCount(leaf('a'))).toBe(1);
  });

  it('counts two panes in a split', () => {
    expect(paneCount(split('horizontal', leaf('a'), leaf('b')))).toBe(2);
  });

  it('counts nested panes', () => {
    const root = split(
      'horizontal',
      split('vertical', leaf('a'), leaf('b')),
      split('vertical', leaf('c'), leaf('d')),
    );
    expect(paneCount(root)).toBe(4);
  });
});
