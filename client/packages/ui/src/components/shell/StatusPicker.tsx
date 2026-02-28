import {
  clearStatusOverride,
  PresenceStatus,
  type StatusOverride,
  setStatusOverride,
  usePresenceStore,
} from '@meza/core';
import * as Popover from '@radix-ui/react-popover';
import { useCallback, useState } from 'react';

const DURATION_OPTIONS = [
  { label: '15 minutes', seconds: 15 * 60 },
  { label: '1 hour', seconds: 60 * 60 },
  { label: '8 hours', seconds: 8 * 60 * 60 },
  { label: '24 hours', seconds: 24 * 60 * 60 },
  { label: '3 days', seconds: 3 * 24 * 60 * 60 },
  { label: 'Until I turn it off', seconds: 0 },
] as const;

const statusDotClass: Record<string, string> = {
  online: 'bg-success',
  dnd: 'bg-error',
  invisible: 'border-2 border-text-subtle bg-transparent',
};

function StatusDot({ variant }: { variant: 'online' | 'dnd' | 'invisible' }) {
  return (
    <span
      className={`inline-block h-2.5 w-2.5 rounded-full ${statusDotClass[variant]}`}
    />
  );
}

function formatRemaining(expiresAt: number): string {
  const diff = expiresAt * 1000 - Date.now();
  if (diff <= 0) return 'Expired';
  const minutes = Math.ceil(diff / 60_000);
  if (minutes < 60) return `${minutes}m remaining`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24)
    return mins > 0 ? `${hours}h ${mins}m remaining` : `${hours}h remaining`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0
    ? `${days}d ${remainingHours}h remaining`
    : `${days}d remaining`;
}

function effectiveStatusLabel(override: StatusOverride | null): string {
  if (!override) return 'Online';
  switch (override.status) {
    case PresenceStatus.DND:
      return 'Do Not Disturb';
    case PresenceStatus.INVISIBLE:
      return 'Invisible';
    case PresenceStatus.OFFLINE:
      return 'Offline';
    default:
      return 'Online';
  }
}

export function StatusPicker() {
  const [open, setOpen] = useState(false);
  const [subMenu, setSubMenu] = useState<'dnd' | 'invisible' | null>(null);
  const myOverride = usePresenceStore((s) => s.myOverride);

  const handleClear = useCallback(() => {
    clearStatusOverride().catch(() => {});
    setOpen(false);
    setSubMenu(null);
  }, []);

  const handleSetOnline = useCallback(() => {
    if (myOverride) {
      clearStatusOverride().catch(() => {});
    }
    setOpen(false);
    setSubMenu(null);
  }, [myOverride]);

  const handleSelectDuration = useCallback(
    (status: PresenceStatus, seconds: number) => {
      setStatusOverride(status, seconds).catch(() => {});
      setOpen(false);
      setSubMenu(null);
    },
    [],
  );

  const currentLabel = effectiveStatusLabel(myOverride);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSubMenu(null);
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className="text-sm text-text-muted truncate hover:text-text transition-colors text-left"
        >
          {currentLabel}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="z-50 w-56 rounded-lg border border-border bg-bg-overlay p-1.5 shadow-lg data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out"
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={16}
        >
          {subMenu === null ? (
            <MainMenu
              myOverride={myOverride}
              onSelectOnline={handleSetOnline}
              onSelectDND={() => setSubMenu('dnd')}
              onSelectInvisible={() => setSubMenu('invisible')}
              onClear={handleClear}
            />
          ) : (
            <DurationMenu
              status={
                subMenu === 'dnd'
                  ? PresenceStatus.DND
                  : PresenceStatus.INVISIBLE
              }
              label={subMenu === 'dnd' ? 'Do Not Disturb' : 'Invisible'}
              onSelect={handleSelectDuration}
              onBack={() => setSubMenu(null)}
            />
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function MainMenu({
  myOverride,
  onSelectOnline,
  onSelectDND,
  onSelectInvisible,
  onClear,
}: {
  myOverride: StatusOverride | null;
  onSelectOnline: () => void;
  onSelectDND: () => void;
  onSelectInvisible: () => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-col">
      {myOverride && (
        <>
          <div className="px-2 py-1.5 text-xs text-text-subtle">
            {myOverride.expiresAt > 0
              ? formatRemaining(myOverride.expiresAt)
              : 'Active until cleared'}
          </div>
          <button
            type="button"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text hover:bg-bg-surface transition-colors"
            onClick={onClear}
          >
            Clear status
          </button>
          <div className="my-1 h-px bg-border" />
        </>
      )}
      <button
        type="button"
        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text hover:bg-bg-surface transition-colors"
        onClick={onSelectOnline}
      >
        <StatusDot variant="online" />
        Online
      </button>
      <button
        type="button"
        className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm text-text hover:bg-bg-surface transition-colors"
        onClick={onSelectDND}
      >
        <span className="flex items-center gap-2">
          <StatusDot variant="dnd" />
          Do Not Disturb
        </span>
        <span className="text-text-subtle text-xs">{'\u203A'}</span>
      </button>
      <button
        type="button"
        className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm text-text hover:bg-bg-surface transition-colors"
        onClick={onSelectInvisible}
      >
        <span className="flex items-center gap-2">
          <StatusDot variant="invisible" />
          Invisible
        </span>
        <span className="text-text-subtle text-xs">{'\u203A'}</span>
      </button>
    </div>
  );
}

function DurationMenu({
  status,
  label,
  onSelect,
  onBack,
}: {
  status: PresenceStatus;
  label: string;
  onSelect: (status: PresenceStatus, seconds: number) => void;
  onBack: () => void;
}) {
  return (
    <div className="flex flex-col">
      <button
        type="button"
        className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-text-muted hover:bg-bg-surface transition-colors"
        onClick={onBack}
      >
        {'\u2039'} {label}
      </button>
      <div className="my-1 h-px bg-border" />
      {DURATION_OPTIONS.map((opt) => (
        <button
          key={opt.seconds}
          type="button"
          className="rounded-md px-2 py-1.5 text-left text-sm text-text hover:bg-bg-surface transition-colors"
          onClick={() => onSelect(status, opt.seconds)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
