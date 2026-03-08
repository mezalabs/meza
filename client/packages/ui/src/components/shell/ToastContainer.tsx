import { useToastStore } from '@meza/core';

const variantClasses: Record<string, string> = {
  info: 'bg-bg-overlay text-text border-border',
  warning: 'bg-bg-overlay text-warning border-warning/40',
  error: 'bg-bg-overlay text-error border-error/40',
};

/**
 * Renders a stack of toast notifications in the bottom-right corner.
 * Toasts auto-dismiss after 5 seconds or can be closed manually.
 */
export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const dismissToast = useToastStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto flex items-center gap-2 rounded-lg border px-4 py-3 text-sm shadow-lg backdrop-blur-sm animate-in slide-in-from-bottom-2 ${variantClasses[toast.variant] ?? variantClasses.info}`}
        >
          <span className="flex-1">{toast.message}</span>
          <button
            type="button"
            className="ml-2 flex-shrink-0 text-text-muted hover:text-text transition-colors"
            onClick={() => dismissToast(toast.id)}
            aria-label="Dismiss"
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
