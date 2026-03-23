import * as Dialog from '@radix-ui/react-dialog';

interface SyncConfirmationDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  channelName: string;
  categoryName: string;
  overrideCount: number;
  isSyncing: boolean;
}

export function SyncConfirmationDialog({
  isOpen,
  onClose,
  onConfirm,
  channelName,
  categoryName,
  overrideCount,
  isSyncing,
}: SyncConfirmationDialogProps) {
  const guardedOpenChange = (open: boolean) => {
    if (!open && isSyncing) return;
    if (!open) onClose();
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={guardedOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl bg-bg-elevated p-6 shadow-lg animate-scale-in"
          onEscapeKeyDown={(e) => {
            if (isSyncing) e.preventDefault();
          }}
        >
          <Dialog.Title className="text-lg font-semibold text-text">
            Sync Channel Permissions
          </Dialog.Title>

          <p className="mt-3 text-sm text-text-muted">
            This will sync permissions for{' '}
            <strong className="text-text">#{channelName}</strong> with the{' '}
            <strong className="text-text">{categoryName}</strong> category.
          </p>

          {overrideCount > 0 && (
            <p className="mt-2 text-sm text-warning">
              {overrideCount} custom{' '}
              {overrideCount === 1 ? 'override' : 'overrides'} will be removed.
              This action cannot be undone.
            </p>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button
                type="button"
                disabled={isSyncing}
                className="rounded-md bg-bg-surface px-3 py-1.5 text-sm text-text-muted hover:bg-bg-elevated hover:text-text disabled:opacity-50"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              disabled={isSyncing}
              onClick={onConfirm}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent/80 disabled:opacity-50"
            >
              {isSyncing ? 'Syncing...' : 'Sync Permissions'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
