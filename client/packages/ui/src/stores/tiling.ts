import {
  allPaneIds,
  type DropPosition,
  movePane as movePaneInTree,
  type PaneContent,
  type PaneId,
  paneCount,
  removePane,
  type SplitDirection,
  splitPane,
  type TilingNode,
  type TreePath,
  updateRatio,
  useAuthStore,
} from '@meza/core';
import { nanoid } from 'nanoid';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export const MAX_PANES = 8;
const INITIAL_PANE_ID = 'initial';

export interface TilingState {
  root: TilingNode;
  focusedPaneId: PaneId;
  panes: Record<PaneId, PaneContent>;
  overlayContent: PaneContent | null;
}

export interface TilingActions {
  focusPane: (id: PaneId) => void;
  splitFocused: (
    direction: SplitDirection,
    content?: PaneContent,
    before?: boolean,
  ) => void;
  closeFocused: () => void;
  closePane: (id: PaneId) => void;
  closePanesMatching: (predicate: (content: PaneContent) => boolean) => void;
  updateRatio: (path: TreePath, ratio: number) => void;
  setPaneContent: (id: PaneId, content: PaneContent) => void;
  resetLayout: () => void;
  moveFocus: (direction: 'left' | 'right' | 'up' | 'down') => void;
  cycleFocus: () => void;
  setOverlay: (content: PaneContent) => void;
  closeOverlay: () => void;
  swapPanes: (sourceId: PaneId, targetId: PaneId) => void;
  movePane: (
    sourceId: PaneId,
    targetId: PaneId,
    position: Exclude<DropPosition, 'center'>,
  ) => void;
  splitAtPane: (
    targetId: PaneId,
    content: PaneContent,
    position: Exclude<DropPosition, 'center'>,
  ) => void;
}

export const useTilingStore = create<TilingState & TilingActions>()(
  immer((set, get) => ({
    root: { type: 'pane', id: INITIAL_PANE_ID },
    focusedPaneId: INITIAL_PANE_ID,
    panes: { [INITIAL_PANE_ID]: { type: 'empty' } },
    overlayContent: null,

    focusPane: (id) => {
      set((state) => {
        state.focusedPaneId = id;
      });
    },

    splitFocused: (direction, content, before) => {
      const simpleMode = useAuthStore.getState().user?.simpleMode ?? false;
      if (simpleMode) {
        if (content) {
          set((state) => {
            state.panes[state.focusedPaneId] = content;
          });
        }
        return;
      }
      set((state) => {
        const { root, focusedPaneId } = state;
        if (paneCount(root) >= MAX_PANES) return;

        const newId = nanoid(8);
        state.root = splitPane(root, focusedPaneId, direction, newId, before);
        state.panes[newId] = content ?? { type: 'empty' };
        state.focusedPaneId = newId;
      });
    },

    closeFocused: () => {
      const { focusedPaneId } = get();
      get().closePane(focusedPaneId);
    },

    closePane: (id) => {
      set((state) => {
        const { root } = state;
        const ids = allPaneIds(root);

        // Last pane: reset to empty instead of removing
        if (ids.length <= 1) {
          state.panes[id] = { type: 'empty' };
          return;
        }

        const newRoot = removePane(root, id);
        if (!newRoot) return;

        delete state.panes[id];
        state.root = newRoot;

        // Move focus to a remaining pane if the closed pane was focused
        if (state.focusedPaneId === id) {
          const remaining = allPaneIds(newRoot);
          state.focusedPaneId = remaining[0] ?? state.focusedPaneId;
        }
      });
    },

    closePanesMatching: (predicate) => {
      set((state) => {
        const toClose = Object.entries(state.panes)
          .filter(([, content]) => predicate(content))
          .map(([id]) => id);

        for (const id of toClose) {
          const ids = allPaneIds(state.root);
          if (ids.length <= 1) {
            state.panes[id] = { type: 'empty' };
            continue;
          }
          const newRoot = removePane(state.root, id);
          if (!newRoot) continue;
          delete state.panes[id];
          state.root = newRoot;
          if (state.focusedPaneId === id) {
            const remaining = allPaneIds(newRoot);
            state.focusedPaneId = remaining[0] ?? state.focusedPaneId;
          }
        }
      });
    },

    updateRatio: (path, ratio) => {
      set((state) => {
        state.root = updateRatio(state.root, path, ratio);
      });
    },

    setPaneContent: (id, content) => {
      set((state) => {
        state.panes[id] = content;
      });
    },

    resetLayout: () => {
      set((state) => {
        const focusedContent = state.panes[state.focusedPaneId] ?? {
          type: 'empty' as const,
        };
        const newId = nanoid(8);
        state.root = { type: 'pane', id: newId };
        state.panes = { [newId]: focusedContent };
        state.focusedPaneId = newId;
      });
    },

    moveFocus: (direction) => {
      const { focusedPaneId } = get();
      const paneElements =
        document.querySelectorAll<HTMLElement>('[data-pane-id]');
      const rects = new Map<string, DOMRect>();

      for (const el of paneElements) {
        const id = el.dataset.paneId;
        if (id) rects.set(id, el.getBoundingClientRect());
      }

      const focusedRect = rects.get(focusedPaneId);
      if (!focusedRect) return;

      const focusedCenter = {
        x: focusedRect.left + focusedRect.width / 2,
        y: focusedRect.top + focusedRect.height / 2,
      };

      let bestId: string | null = null;
      let bestDistance = Infinity;

      for (const [id, rect] of rects) {
        if (id === focusedPaneId) continue;

        const center = {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };

        const isValid =
          (direction === 'left' && center.x < focusedCenter.x) ||
          (direction === 'right' && center.x > focusedCenter.x) ||
          (direction === 'up' && center.y < focusedCenter.y) ||
          (direction === 'down' && center.y > focusedCenter.y);

        if (!isValid) continue;

        const dx = center.x - focusedCenter.x;
        const dy = center.y - focusedCenter.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < bestDistance) {
          bestDistance = distance;
          bestId = id;
        }
      }

      if (bestId) {
        set((state) => {
          state.focusedPaneId = bestId;
        });
      }
    },

    cycleFocus: () => {
      set((state) => {
        const ids = allPaneIds(state.root);
        const currentIndex = ids.indexOf(state.focusedPaneId);
        const nextIndex = (currentIndex + 1) % ids.length;
        state.focusedPaneId = ids[nextIndex] ?? state.focusedPaneId;
      });
    },

    setOverlay: (content) => {
      set((state) => {
        state.overlayContent = content;
      });
    },

    closeOverlay: () => {
      set((state) => {
        state.overlayContent = null;
      });
    },

    swapPanes: (sourceId, targetId) => {
      set((state) => {
        const sourceContent = state.panes[sourceId];
        const targetContent = state.panes[targetId];
        if (!sourceContent || !targetContent) return;
        state.panes[sourceId] = targetContent;
        state.panes[targetId] = sourceContent;
        state.focusedPaneId = targetId;
      });
    },

    movePane: (sourceId, targetId, position) => {
      set((state) => {
        const newRoot = movePaneInTree(
          state.root,
          sourceId,
          targetId,
          position,
        );
        if (!newRoot) return;
        state.root = newRoot;
        state.focusedPaneId = sourceId;
      });
    },

    splitAtPane: (targetId, content, position) => {
      const simpleMode = useAuthStore.getState().user?.simpleMode ?? false;
      if (simpleMode) {
        set((state) => {
          state.panes[targetId] = content;
        });
        return;
      }
      set((state) => {
        if (paneCount(state.root) >= MAX_PANES) {
          state.panes[targetId] = content;
          state.focusedPaneId = targetId;
          return;
        }
        const newId = nanoid(8);
        const direction: SplitDirection =
          position === 'left' || position === 'right'
            ? 'horizontal'
            : 'vertical';
        const before = position === 'left' || position === 'top';
        state.root = splitPane(state.root, targetId, direction, newId, before);
        state.panes[newId] = content;
        state.focusedPaneId = newId;
      });
    },
  })),
);

export function useSimpleMode(): boolean {
  return useAuthStore((s) => s.user?.simpleMode ?? false);
}

/**
 * Open a user's profile as an overlay on top of all panes.
 */
export function openProfilePane(userId: string) {
  useTilingStore.getState().setOverlay({ type: 'profile', userId });
}

/**
 * Open channel settings as an overlay on top of all panes.
 */
export function openChannelSettingsPane(serverId: string, channelId: string) {
  useTilingStore.getState().setOverlay({
    type: 'channelSettings',
    serverId,
    channelId,
  });
}

/**
 * Close all panes showing a specific channel (channel view, channel settings, voice).
 * Used when a channel is deleted to clean up stale panes.
 */
export function closeChannelPanes(channelId: string) {
  useTilingStore
    .getState()
    .closePanesMatching(
      (content) =>
        (content.type === 'channel' && content.channelId === channelId) ||
        (content.type === 'channelSettings' &&
          content.channelId === channelId) ||
        (content.type === 'voice' && content.channelId === channelId) ||
        (content.type === 'screenShare' && content.channelId === channelId),
    );
}

/**
 * Open a search pane. If a search pane already exists, focus it and
 * optionally update its query. Otherwise, replace the focused pane content.
 */
export function openSearchPane(query?: string) {
  const store = useTilingStore.getState();

  for (const [paneId, content] of Object.entries(store.panes)) {
    if (content.type === 'search') {
      store.focusPane(paneId);
      if (query !== undefined) {
        store.setPaneContent(paneId, { type: 'search', query });
      }
      return;
    }
  }

  store.setPaneContent(store.focusedPaneId, { type: 'search', query });
}
