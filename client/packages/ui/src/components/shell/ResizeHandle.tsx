import type { TreePath } from '@meza/core';
import { useCallback, useRef } from 'react';
import { useTilingStore } from '../../stores/tiling.ts';

interface ResizeHandleProps {
  direction: 'horizontal' | 'vertical';
  path: TreePath;
}

export function ResizeHandle({ direction, path }: ResizeHandleProps) {
  const isHorizontal = direction === 'horizontal';
  const updateRatio = useTilingStore((s) => s.updateRatio);
  const ratio = useTilingStore((s) => {
    let node = s.root;
    for (const step of path) {
      if (node.type === 'split') node = node[step];
    }
    return node.type === 'split' ? node.ratio : 0.5;
  });
  const rafId = useRef(0);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);

      const parentEl = handle.parentElement;
      if (!parentEl) return;

      const parentRect = parentEl.getBoundingClientRect();
      const parentSize = isHorizontal ? parentRect.width : parentRect.height;
      const parentStart = isHorizontal ? parentRect.left : parentRect.top;

      const onPointerMove = (moveEvent: PointerEvent) => {
        cancelAnimationFrame(rafId.current);
        rafId.current = requestAnimationFrame(() => {
          const clientPos = isHorizontal
            ? moveEvent.clientX
            : moveEvent.clientY;
          const newRatio = (clientPos - parentStart) / parentSize;
          updateRatio(path, newRatio);
        });
      };

      const onPointerUp = () => {
        cancelAnimationFrame(rafId.current);
        handle.removeEventListener('pointermove', onPointerMove);
        handle.removeEventListener('pointerup', onPointerUp);
      };

      handle.addEventListener('pointermove', onPointerMove);
      handle.addEventListener('pointerup', onPointerUp);
    },
    [isHorizontal, path, updateRatio],
  );

  const handleDoubleClick = useCallback(() => {
    updateRatio(path, 0.5);
  }, [path, updateRatio]);

  return (
    // biome-ignore lint/a11y/useSemanticElements: <hr> is a thematic break, not an interactive resize handle
    <div
      onPointerDown={handlePointerDown}
      onDoubleClick={handleDoubleClick}
      className={`flex-shrink-0 select-none rounded-sm transition-colors ${
        isHorizontal
          ? 'w-1.5 cursor-col-resize hover:bg-accent/50'
          : 'h-1.5 cursor-row-resize hover:bg-accent/50'
      }`}
      role="separator"
      aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={10}
      aria-valuemax={90}
      aria-label="Resize panes"
      tabIndex={0}
    />
  );
}
