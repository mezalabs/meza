import type { PaneId, TilingNode, TreePath } from '@meza/core';
import { memo } from 'react';
import { ResizeHandle } from './ResizeHandle.tsx';

interface TilingRendererProps {
  node: TilingNode;
  renderPane: (paneId: PaneId) => React.ReactNode;
  path?: TreePath;
}

export const TilingRenderer = memo(function TilingRenderer({
  node,
  renderPane,
  path = [],
}: TilingRendererProps) {
  if (node.type === 'pane') {
    return (
      <div className="flex min-h-0 min-w-0 flex-1">{renderPane(node.id)}</div>
    );
  }

  const isHorizontal = node.direction === 'horizontal';

  return (
    <div
      className={`flex min-h-0 min-w-0 ${
        isHorizontal ? 'flex-row' : 'flex-col'
      }`}
      style={{ flex: 1 }}
    >
      <div
        className="flex min-h-0 min-w-0 overflow-hidden"
        style={{ flex: node.ratio }}
      >
        <TilingRenderer
          node={node.first}
          renderPane={renderPane}
          path={[...path, 'first']}
        />
      </div>

      <ResizeHandle direction={node.direction} path={path} />

      <div
        className="flex min-h-0 min-w-0 overflow-hidden"
        style={{ flex: 1 - node.ratio }}
      >
        <TilingRenderer
          node={node.second}
          renderPane={renderPane}
          path={[...path, 'second']}
        />
      </div>
    </div>
  );
});
