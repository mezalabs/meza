import type { DropPosition } from '@meza/core';
import { useDroppable } from '@dnd-kit/core';
import type { ReactNode } from 'react';

interface PaneSlotProps {
  paneId: string;
  isDragging: boolean;
  children: ReactNode;
}

export function PaneSlot({
  paneId,
  isDragging,
  children,
}: PaneSlotProps) {
  const { setNodeRef } = useDroppable({
    id: `drop-${paneId}`,
    data: { paneId },
    disabled: isDragging,
  });

  return (
    <div
      ref={setNodeRef}
      data-pane-id={paneId}
      className="flex flex-1 min-h-0 min-w-0"
    >
      {children}
    </div>
  );
}

const edgeStyles: Record<Exclude<DropPosition, 'center'>, string> = {
  left: 'inset-y-0 left-0 w-1/2',
  right: 'inset-y-0 right-0 w-1/2',
  top: 'inset-x-0 top-0 h-1/2',
  bottom: 'inset-x-0 bottom-0 h-1/2',
};

export function DropZoneOverlay({ zone }: { zone: DropPosition }) {
  if (zone === 'center') {
    return (
      <div className="pointer-events-none absolute inset-0 z-10 rounded-xl border-2 border-accent bg-accent/10" />
    );
  }

  return (
    <div
      className={`pointer-events-none absolute z-10 bg-accent/10 ${edgeStyles[zone]}`}
    />
  );
}
