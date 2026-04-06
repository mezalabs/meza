import type { ScreenSource } from '@meza/core';
import { AppWindowIcon, MonitorIcon, ShieldCheck } from '@phosphor-icons/react';
import * as Dialog from '@radix-ui/react-dialog';

interface ScreenPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sources: ScreenSource[] | null;
  selectedSourceId: string | null;
  onSelectSource: (id: string | null) => void;
  onShare: () => void;
  onCancel: () => void;
  error: string | null;
  onRetry: () => void;
}

export function ScreenPickerDialog({
  open,
  onOpenChange,
  sources,
  selectedSourceId,
  onSelectSource,
  onShare,
  onCancel,
  error,
  onRetry,
}: ScreenPickerDialogProps) {
  const screens = sources?.filter((s) => s.id.startsWith('screen:')) ?? [];
  const windows = sources?.filter((s) => s.id.startsWith('window:')) ?? [];

  // macOS permission denied: sources returned as empty array with no error.
  // Only show permission guidance on macOS (detected via electronAPI platform).
  const platform = window.electronAPI?.app?.getPlatform?.();
  const isMacPermissionIssue =
    sources !== null && sources.length === 0 && !error && platform === 'darwin';

  const handleOpenChange = (next: boolean) => {
    if (!next) onCancel();
    onOpenChange(next);
  };

  const handleDoubleClick = (id: string) => {
    onSelectSource(id);
    // Defer to allow state update before share
    setTimeout(onShare, 0);
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 animate-fade-in" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 z-50 w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 rounded-xl bg-bg-elevated shadow-lg animate-scale-in"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <Dialog.Title className="sr-only">Share Your Screen</Dialog.Title>
          <Dialog.Description className="sr-only">
            Select a screen or window to share
          </Dialog.Description>

          {/* Header */}
          <div className="flex items-baseline justify-between gap-4 px-6 pt-6 pb-4">
            <div>
              <h2 className="text-lg font-semibold text-text">
                Share Your Screen
              </h2>
              <p className="mt-0.5 text-xs text-text-muted">
                Choose a display or window to share with the call
              </p>
            </div>
          </div>

          {/* Content */}
          <div className="overflow-y-auto px-6 pb-2 max-h-[60vh] min-h-[280px]">
            {error ? (
              <ErrorState message={error} onRetry={onRetry} />
            ) : isMacPermissionIssue ? (
              <PermissionState />
            ) : sources === null ? (
              <LoadingState />
            ) : screens.length === 0 && windows.length === 0 ? (
              <EmptyState />
            ) : (
              <div className="space-y-6 pb-4">
                {screens.length > 0 && (
                  <Section
                    icon={<MonitorIcon size={14} weight="bold" />}
                    label="Displays"
                    count={screens.length}
                  >
                    <div className="grid grid-cols-2 gap-3">
                      {screens.map((source) => (
                        <SourceCard
                          key={source.id}
                          source={source}
                          selected={selectedSourceId === source.id}
                          size="lg"
                          onSelect={() => onSelectSource(source.id)}
                          onDoubleClick={() => handleDoubleClick(source.id)}
                        />
                      ))}
                    </div>
                  </Section>
                )}

                {windows.length > 0 && (
                  <Section
                    icon={<AppWindowIcon size={14} weight="bold" />}
                    label="Windows"
                    count={windows.length}
                  >
                    <div className="grid grid-cols-3 gap-3">
                      {windows.map((source) => (
                        <SourceCard
                          key={source.id}
                          source={source}
                          selected={selectedSourceId === source.id}
                          size="sm"
                          onSelect={() => onSelectSource(source.id)}
                          onDoubleClick={() => handleDoubleClick(source.id)}
                        />
                      ))}
                    </div>
                  </Section>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md bg-bg-surface px-3 py-1.5 text-sm text-text-muted hover:bg-bg-elevated hover:text-text"
            >
              Cancel
            </button>
            {!isMacPermissionIssue && (
              <button
                type="button"
                disabled={!selectedSourceId}
                onClick={onShare}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-50"
              >
                Share
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Section({
  icon,
  label,
  count,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2.5 flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-text-subtle">
          {icon}
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em]">
            {label}
          </span>
        </span>
        <span className="text-[11px] font-medium text-text-subtle">
          {count}
        </span>
        <div className="ml-1 h-px flex-1 bg-border" />
      </div>
      {children}
    </section>
  );
}

function SourceCard({
  source,
  selected,
  size,
  onSelect,
  onDoubleClick,
}: {
  source: ScreenSource;
  selected: boolean;
  size: 'sm' | 'lg';
  onSelect: () => void;
  onDoubleClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      onDoubleClick={onDoubleClick}
      className={`group flex flex-col overflow-hidden rounded-md bg-bg-surface cursor-pointer transition-all text-left ${
        selected
          ? 'ring-2 ring-accent'
          : 'ring-1 ring-border hover:ring-border-hover'
      }`}
    >
      <div className="aspect-video overflow-hidden bg-bg-base">
        {source.thumbnail ? (
          <img
            src={`data:image/jpeg;base64,${source.thumbnail}`}
            alt={source.name}
            className="h-full w-full object-contain transition-transform duration-200 group-hover:scale-[1.02]"
            decoding="async"
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <MonitorIcon
              size={size === 'lg' ? 28 : 20}
              className="text-text-subtle"
            />
          </div>
        )}
      </div>
      <span
        className={`truncate px-2.5 ${size === 'lg' ? 'py-2 text-sm' : 'py-1.5 text-xs'} ${
          selected ? 'text-text' : 'text-text-muted group-hover:text-text'
        }`}
      >
        {source.name}
      </span>
    </button>
  );
}

function LoadingState() {
  return (
    <div className="flex items-center justify-center py-16">
      <p className="text-sm text-text-muted">Loading sources...</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16">
      <MonitorIcon size={24} className="text-text-subtle" />
      <p className="text-sm text-text-muted">No sources available</p>
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16">
      <MonitorIcon size={24} className="text-text-subtle" />
      <p className="text-sm text-text-muted">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md bg-bg-surface px-3 py-1.5 text-sm text-text hover:bg-bg-elevated transition-colors"
      >
        Retry
      </button>
    </div>
  );
}

function PermissionState() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-12 px-8 text-center">
      <ShieldCheck size={32} className="text-text-subtle" />
      <div>
        <p className="text-sm font-medium text-text">
          Screen Recording Permission Required
        </p>
        <p className="mt-1 text-sm text-text-muted max-w-xs">
          Meza needs screen recording permission to share your screen. Open
          System Settings to grant access.
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          window.electronAPI?.screenShare?.openSettings();
        }}
        className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent-hover"
      >
        Open System Settings
      </button>
      <p className="text-xs text-text-subtle">
        You may need to restart the app after granting permission.
      </p>
    </div>
  );
}
