import type { DMChannel } from '@meza/core';
import {
  acceptMessageRequest,
  declineMessageRequest,
  listMessageRequests,
  useAuthStore,
  useDMStore,
} from '@meza/core';
import { useCallback, useEffect, useState } from 'react';
import { useTilingStore } from '../../stores/tiling.ts';

export function MessageRequestsPane() {
  const messageRequests = useDMStore((s) => s.messageRequests);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const setPaneContent = useTilingStore((s) => s.setPaneContent);
  const focusedPaneId = useTilingStore((s) => s.focusedPaneId);

  useEffect(() => {
    listMessageRequests().catch(() => {});
  }, []);

  const selected = messageRequests.find((r) => r.channel?.id === selectedId);

  const handleAccept = useCallback(
    async (channelId: string) => {
      await acceptMessageRequest(channelId);
      if (focusedPaneId) {
        setPaneContent(focusedPaneId, {
          type: 'dm',
          conversationId: channelId,
        });
      }
    },
    [focusedPaneId, setPaneContent],
  );

  const handleDecline = useCallback(async (channelId: string) => {
    await declineMessageRequest(channelId);
    setSelectedId(null);
  }, []);

  return (
    <div className="flex flex-1 min-h-0 min-w-0">
      {/* Request list sidebar */}
      <div className="flex flex-col w-64 min-w-0 border-r border-border bg-bg-secondary">
        <div className="p-3 border-b border-border">
          <h2 className="text-sm font-semibold text-text-primary">
            Message Requests
          </h2>
          <p className="text-xs text-text-subtle mt-1">
            {messageRequests.length} pending
          </p>
        </div>
        <div className="flex-1 overflow-y-auto">
          {messageRequests.length === 0 ? (
            <div className="p-4 text-center text-xs text-text-subtle">
              No pending requests
            </div>
          ) : (
            messageRequests.map((request) => {
              const other = request.participants.find(
                (p) => p.id !== currentUserId,
              );
              const channelId = request.channel?.id;
              if (!channelId) return null;
              return (
                <button
                  type="button"
                  key={channelId}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-bg-tertiary transition-colors ${
                    selectedId === channelId ? 'bg-bg-tertiary' : ''
                  }`}
                  onClick={() => setSelectedId(channelId)}
                >
                  <div className="size-8 rounded-full bg-bg-tertiary flex items-center justify-center text-xs font-semibold text-text-primary shrink-0">
                    {(other?.displayName ||
                      other?.username ||
                      '?')[0]?.toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-text-primary truncate">
                      {other?.displayName || other?.username || 'Unknown'}
                    </div>
                    <div className="text-xs text-text-subtle truncate">
                      @{other?.username || 'unknown'}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Request detail */}
      <div className="flex flex-col flex-1 min-w-0">
        {selected ? (
          <RequestDetail
            request={selected}
            currentUserId={currentUserId}
            onAccept={handleAccept}
            onDecline={handleDecline}
          />
        ) : (
          <div className="flex items-center justify-center flex-1 text-text-subtle text-sm">
            Select a request to preview
          </div>
        )}
      </div>
    </div>
  );
}

function RequestDetail({
  request,
  currentUserId,
  onAccept,
  onDecline,
}: {
  request: DMChannel;
  currentUserId: string | undefined;
  onAccept: (channelId: string) => Promise<void>;
  onDecline: (channelId: string) => Promise<void>;
}) {
  const other = request.participants.find((p) => p.id !== currentUserId);
  const channelId = request.channel?.id;
  const [loading, setLoading] = useState(false);

  if (!channelId) return null;

  return (
    <>
      {/* Header with accept/decline */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-secondary">
        <div className="flex items-center gap-2">
          <div className="size-8 rounded-full bg-bg-tertiary flex items-center justify-center text-xs font-semibold text-text-primary">
            {(other?.displayName || other?.username || '?')[0]?.toUpperCase()}
          </div>
          <div>
            <span className="text-sm font-semibold text-text-primary">
              {other?.displayName || other?.username || 'Unknown'}
            </span>
            <span className="text-xs text-text-subtle ml-2">
              wants to message you
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="px-3 py-1.5 text-xs font-medium rounded bg-green-600 text-white hover:bg-green-500 transition-colors disabled:opacity-50"
            disabled={loading}
            onClick={async () => {
              setLoading(true);
              try {
                await onAccept(channelId);
              } finally {
                setLoading(false);
              }
            }}
          >
            Accept
          </button>
          <button
            type="button"
            className="px-3 py-1.5 text-xs font-medium rounded bg-red-600 text-white hover:bg-red-500 transition-colors disabled:opacity-50"
            disabled={loading}
            onClick={async () => {
              setLoading(true);
              try {
                await onDecline(channelId);
              } finally {
                setLoading(false);
              }
            }}
          >
            Decline
          </button>
        </div>
      </div>

      {/* Preview area — read-only, no composer */}
      <div className="flex-1 flex items-center justify-center text-text-subtle text-sm p-4">
        <p>
          Message preview will appear here once E2EE decryption is available for
          this channel.
        </p>
      </div>
    </>
  );
}
