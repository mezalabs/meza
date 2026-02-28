import type {
  DropPosition,
  PaneId,
  PaneSplit,
  SplitDirection,
  TilingNode,
  TreePath,
} from './types.ts';

const MIN_RATIO = 0.1;
const MAX_RATIO = 0.9;

function clampRatio(ratio: number): number {
  return Math.max(MIN_RATIO, Math.min(MAX_RATIO, ratio));
}

/**
 * Replace a pane with a split containing the original pane and a new pane.
 * When `before` is true the new pane is inserted before (left/above) the target.
 */
export function splitPane(
  root: TilingNode,
  targetId: PaneId,
  direction: SplitDirection,
  newPaneId: PaneId,
  before?: boolean,
): TilingNode {
  if (root.type === 'pane') {
    if (root.id === targetId) {
      const newLeaf = { type: 'pane' as const, id: newPaneId };
      return {
        type: 'split',
        direction,
        ratio: 0.5,
        first: before ? newLeaf : root,
        second: before ? root : newLeaf,
      } satisfies PaneSplit;
    }
    return root;
  }

  return {
    ...root,
    first: splitPane(root.first, targetId, direction, newPaneId, before),
    second: splitPane(root.second, targetId, direction, newPaneId, before),
  };
}

/**
 * Remove a pane from the tree, promoting its sibling to replace the parent split.
 * Returns null if the root itself is the target pane.
 */
export function removePane(
  root: TilingNode,
  targetId: PaneId,
): TilingNode | null {
  if (root.type === 'pane') {
    return root.id === targetId ? null : root;
  }

  const firstResult = removePane(root.first, targetId);
  const secondResult = removePane(root.second, targetId);

  // Target was in the first child — promote second
  if (firstResult === null) return secondResult;
  // Target was in the second child — promote first
  if (secondResult === null) return firstResult;
  // Target was deeper — rebuild with updated children
  return { ...root, first: firstResult, second: secondResult };
}

/**
 * Update the split ratio at a given tree path.
 */
export function updateRatio(
  root: TilingNode,
  path: TreePath,
  newRatio: number,
): TilingNode {
  if (path.length === 0) {
    if (root.type === 'split') {
      return { ...root, ratio: clampRatio(newRatio) };
    }
    return root;
  }

  if (root.type === 'split') {
    const [head, ...rest] = path;
    return {
      ...root,
      [head]: updateRatio(root[head], rest, newRatio),
    };
  }

  return root;
}

/**
 * Collect all pane IDs via in-order traversal.
 */
export function allPaneIds(node: TilingNode): PaneId[] {
  if (node.type === 'pane') return [node.id];
  return [...allPaneIds(node.first), ...allPaneIds(node.second)];
}

/**
 * Find the path to a pane by its ID.
 * Returns null if not found.
 */
export function findPane(node: TilingNode, id: PaneId): TreePath | null {
  if (node.type === 'pane') {
    return node.id === id ? [] : null;
  }

  const inFirst = findPane(node.first, id);
  if (inFirst !== null) return ['first', ...inFirst];

  const inSecond = findPane(node.second, id);
  if (inSecond !== null) return ['second', ...inSecond];

  return null;
}

/**
 * Count the number of leaf panes in the tree.
 */
export function paneCount(node: TilingNode): number {
  if (node.type === 'pane') return 1;
  return paneCount(node.first) + paneCount(node.second);
}

/**
 * Get the sibling's path for a given pane path.
 * Returns null if the pane is the root (no parent split).
 */
export function findParentSplit(
  node: TilingNode,
  targetId: PaneId,
): { split: PaneSplit; side: 'first' | 'second'; path: TreePath } | null {
  if (node.type === 'pane') return null;

  if (node.first.type === 'pane' && node.first.id === targetId) {
    return { split: node as PaneSplit, side: 'first', path: [] };
  }
  if (node.second.type === 'pane' && node.second.id === targetId) {
    return { split: node as PaneSplit, side: 'second', path: [] };
  }

  const inFirst = findParentSplit(node.first, targetId);
  if (inFirst) return { ...inFirst, path: ['first', ...inFirst.path] };

  const inSecond = findParentSplit(node.second, targetId);
  if (inSecond) return { ...inSecond, path: ['second', ...inSecond.path] };

  return null;
}

/**
 * If two panes are direct siblings (both leaves of the same split),
 * return the edge zone that previews where the source will land
 * (i.e. the source's current side). Returns null when not siblings.
 */
export function siblingSwapZone(
  node: TilingNode,
  sourceId: PaneId,
  targetId: PaneId,
): Exclude<DropPosition, 'center'> | null {
  if (node.type === 'pane') return null;
  const srcFirst = node.first.type === 'pane' && node.first.id === sourceId;
  const srcSecond = node.second.type === 'pane' && node.second.id === sourceId;
  const tgtFirst = node.first.type === 'pane' && node.first.id === targetId;
  const tgtSecond = node.second.type === 'pane' && node.second.id === targetId;
  // Source is first (left/top), target is second — gap opens on source's side
  if (srcFirst && tgtSecond) {
    return node.direction === 'horizontal' ? 'left' : 'top';
  }
  // Source is second (right/bottom), target is first
  if (srcSecond && tgtFirst) {
    return node.direction === 'horizontal' ? 'right' : 'bottom';
  }
  return (
    siblingSwapZone(node.first, sourceId, targetId) ??
    siblingSwapZone(node.second, sourceId, targetId)
  );
}

/**
 * Move a pane from one position to another by removing it and splitting
 * the target. Reuses the source pane's ID so its PaneContent stays valid.
 */
export function movePane(
  root: TilingNode,
  sourceId: PaneId,
  targetId: PaneId,
  position: Exclude<DropPosition, 'center'>,
): TilingNode | null {
  const afterRemove = removePane(root, sourceId);
  if (!afterRemove) return null;
  const direction: SplitDirection =
    position === 'left' || position === 'right' ? 'horizontal' : 'vertical';
  const before = position === 'left' || position === 'top';
  return splitPane(afterRemove, targetId, direction, sourceId, before);
}
