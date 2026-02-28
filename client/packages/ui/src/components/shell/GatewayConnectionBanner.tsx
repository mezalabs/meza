import { gatewayConnect, useAuthStore, useGatewayStore } from '@meza/core';

/**
 * Banner shown above the content area when the gateway connection is unhealthy.
 * Reconnecting: amber pulsing dot with attempt count.
 * Disconnected: red banner with manual reconnect button.
 */
export function GatewayConnectionBanner() {
  const status = useGatewayStore((s) => s.status);
  const attempt = useGatewayStore((s) => s.reconnectAttempt);

  if (status === 'connected' || status === 'connecting') return null;

  if (status === 'reconnecting') {
    return (
      <div className="flex-shrink-0 border-b border-border bg-bg-overlay px-3 py-1.5">
        <div className="flex items-center gap-2 text-sm text-warning">
          <span className="h-2 w-2 flex-shrink-0 rounded-full bg-warning animate-pulse" />
          <span>
            Reconnecting{attempt > 1 ? ` (attempt ${attempt})` : ''}...
          </span>
        </div>
      </div>
    );
  }

  // status === 'disconnected'
  return (
    <div className="flex-shrink-0 border-b border-border bg-bg-overlay px-3 py-1.5">
      <div className="flex items-center gap-2 text-sm text-error">
        <span className="h-2 w-2 flex-shrink-0 rounded-full bg-error" />
        <span className="flex-1">Connection lost</span>
        <button
          type="button"
          className="rounded px-2 py-0.5 text-xs font-medium text-text hover:bg-bg-surface transition-colors"
          onClick={() => {
            const token = useAuthStore.getState().accessToken;
            if (token) gatewayConnect(token);
          }}
        >
          Reconnect
        </button>
      </div>
    </div>
  );
}
