import { WarningIcon } from '@phosphor-icons/react';
import * as Dialog from '@radix-ui/react-dialog';
import { useDangerousDownloadStore } from '../../stores/dangerousDownload.ts';

/**
 * Global confirmation shown before downloading a file whose type could run code
 * (or hide something that does). Mounted once per shell; driven entirely by
 * {@link useDangerousDownloadStore}. "Close" is the focused default so the safe
 * choice is one keystroke away.
 */
export function DangerousDownloadDialog() {
  const pending = useDangerousDownloadStore((s) => s.pending);
  const confirm = useDangerousDownloadStore((s) => s.confirm);
  const cancel = useDangerousDownloadStore((s) => s.cancel);

  return (
    <Dialog.Root
      open={pending !== null}
      onOpenChange={(next) => {
        if (!next) cancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 animate-fade-in" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl bg-bg-elevated p-6 shadow-lg animate-scale-in">
          <Dialog.Title className="flex items-center gap-2 text-lg font-semibold text-text">
            <WarningIcon
              size={20}
              weight="fill"
              className="flex-shrink-0 text-warning"
              aria-hidden="true"
            />
            Potentially dangerous download
          </Dialog.Title>

          <Dialog.Description className="mt-2 text-sm text-text-muted">
            <span className="break-all font-medium text-text">
              {pending?.filename}
            </span>{' '}
            is a type of file that could harm your device. Only open it if you
            trust whoever sent it.
          </Dialog.Description>

          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-accent-hover"
              >
                Close
              </button>
            </Dialog.Close>
            <button
              type="button"
              onClick={confirm}
              className="rounded-md bg-bg-surface px-3 py-1.5 text-sm text-text-muted hover:bg-bg-elevated hover:text-text"
            >
              Continue to download
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
