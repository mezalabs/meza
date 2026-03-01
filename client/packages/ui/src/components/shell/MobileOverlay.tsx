import { XIcon } from '@phosphor-icons/react';

interface MobileOverlayProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

/**
 * Generic full-screen overlay for mobile secondary panels.
 * Covers the entire viewport (including server rail).
 * Used for member list, pinned messages, search, and settings.
 */
export function MobileOverlay({
  open,
  onClose,
  title,
  children,
}: MobileOverlayProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg-base safe-top safe-bottom">
      <header className="flex h-12 flex-shrink-0 items-center gap-3 border-b border-border/40 px-4">
        <button
          type="button"
          onClick={onClose}
          className="p-2 -ml-2 text-text-muted hover:text-text transition-colors"
          aria-label="Close"
        >
          <XIcon size={20} aria-hidden="true" />
        </button>
        <h2 className="flex-1 truncate text-base font-semibold text-text">
          {title}
        </h2>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
    </div>
  );
}
