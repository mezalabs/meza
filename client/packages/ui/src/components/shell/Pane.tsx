import { useDraggable } from '@dnd-kit/core';
import type { DropPosition } from '@meza/core';
import { getBaseUrl, useAuthStore } from '@meza/core';
import {
  ChatIcon,
  GearIcon,
  PushPinIcon,
  UsersThreeIcon,
  XIcon,
} from '@phosphor-icons/react';
import { type ReactNode, useState } from 'react';
import { DropZoneOverlay } from './PaneSlot.tsx';

interface PaneProps {
  label?: string;
  icon?: ReactNode;
  focused?: boolean;
  showClose?: boolean;
  onClose?: () => void;
  onFocus?: () => void;
  children?: ReactNode;
  paneId?: string;
  serverName?: string;
  serverIconUrl?: string;
  onServerClick?: () => void;
  onToggleMembers?: () => void;
  showMembers?: boolean;
  onTogglePins?: () => void;
  showPins?: boolean;
  onOpenChannelSettings?: () => void;
  isDragSource?: boolean;
  dropZone?: DropPosition | null;
  dragDisabled?: boolean;
}

export function Pane({
  label = 'Empty',
  icon = '#',
  focused: _focused = false,
  showClose = false,
  onClose,
  onFocus,
  children,
  paneId,
  serverName,
  serverIconUrl,
  onServerClick,
  onToggleMembers,
  showMembers,
  onTogglePins,
  showPins,
  onOpenChannelSettings,
  isDragSource = false,
  dropZone,
  dragDisabled = false,
}: PaneProps) {
  const [iconHovered, setIconHovered] = useState(false);
  const token = useAuthStore((s) => s.accessToken);
  const authQuery = token ? `?token=${encodeURIComponent(token)}` : '';
  const base = getBaseUrl();
  const iconSrc = serverIconUrl
    ? `${base}${serverIconUrl}${iconHovered ? '' : '/thumb'}${authQuery}`
    : undefined;

  const {
    attributes: dragAttributes,
    listeners: dragListeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: `drag-${paneId}`,
    data: { type: 'pane' as const, paneId },
    disabled: dragDisabled,
  });

  return (
    <section
      className={`relative flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border/40 shadow-md ${
        isDragSource ? 'opacity-40' : ''
      }`}
      aria-label={label}
      onPointerDown={onFocus}
    >
      {/* Header bar */}
      <div
        ref={setDragRef}
        {...dragAttributes}
        {...dragListeners}
        className={`flex flex-shrink-0 items-center gap-2.5 bg-bg-base px-4 text-sm border-b transition-colors ${
          serverName ? 'h-12' : 'h-10'
        } ${dragDisabled ? 'border-transparent' : isDragging ? 'cursor-grabbing border-transparent' : 'cursor-grab border-transparent hover:border-border/40'}`}
      >
        {serverName && (
          <>
            <button
              type="button"
              className="flex items-center gap-2.5 truncate text-text-subtle hover:text-accent transition-colors"
              onMouseEnter={() => setIconHovered(true)}
              onMouseLeave={() => setIconHovered(false)}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onServerClick?.();
              }}
            >
              {iconSrc ? (
                <img
                  src={iconSrc}
                  alt={serverName}
                  className="h-5 w-5 rounded-sm object-cover flex-shrink-0"
                />
              ) : (
                <span className="flex h-5 w-5 items-center justify-center rounded-sm bg-accent text-[10px] font-bold text-black flex-shrink-0">
                  {serverName.charAt(0).toUpperCase()}
                </span>
              )}
              {serverName}
            </button>
            <span className="text-text-subtle">/</span>
          </>
        )}
        <span className="text-text-subtle">{icon}</span>
        <span className="flex-1 truncate font-medium text-text-muted">
          {label}
        </span>
        {/* aria-disabled={false} prevents dnd-kit's drag handle aria-disabled from disabling nested buttons */}
        <div
          className="flex items-center gap-0.5"
          role="toolbar"
          aria-disabled={false}
        >
          {onOpenChannelSettings && (
            <button
              type="button"
              className="rounded-md p-1 text-text-subtle hover:bg-bg-elevated hover:text-text transition-colors"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onOpenChannelSettings();
              }}
              aria-label="Channel settings"
              title="Channel settings"
            >
              <GearIcon size={16} aria-hidden="true" />
            </button>
          )}
          {onTogglePins && (
            <button
              type="button"
              className={`rounded-md p-1 transition-colors ${
                showPins
                  ? 'text-accent hover:text-accent-hover'
                  : 'text-text-subtle hover:bg-bg-elevated hover:text-text'
              }`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onTogglePins();
              }}
              aria-label={
                showPins ? 'Hide pinned messages' : 'Show pinned messages'
              }
            >
              <PushPinIcon size={16} aria-hidden="true" />
            </button>
          )}
          {onToggleMembers && (
            <button
              type="button"
              className={`rounded-md p-1 transition-colors ${
                showMembers
                  ? 'text-accent hover:text-accent-hover'
                  : 'text-text-subtle hover:bg-bg-elevated hover:text-text'
              }`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onToggleMembers();
              }}
              aria-label={showMembers ? 'Hide members' : 'Show members'}
            >
              <UsersThreeIcon size={16} aria-hidden="true" />
            </button>
          )}
          {showClose && (
            <button
              type="button"
              className="rounded-md p-1 text-text-subtle hover:bg-bg-elevated hover:text-text"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onClose?.();
              }}
              aria-label={`Close ${label}`}
            >
              <XIcon weight="regular" size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col min-h-0 overflow-hidden bg-bg-base">
        {children ?? (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState />
          </div>
        )}
      </div>

      {/* Drop zone overlay */}
      {dropZone && <DropZoneOverlay zone={dropZone} />}
    </section>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-bg-surface">
        <ChatIcon size={24} className="text-text-subtle" aria-hidden="true" />
      </div>
      <p className="text-sm text-text-muted">
        Select a channel to start chatting
      </p>
    </div>
  );
}
