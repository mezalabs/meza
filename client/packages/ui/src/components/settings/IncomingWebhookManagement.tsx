import {
  createIncomingWebhook,
  deleteIncomingWebhook,
  getBaseUrl,
  type IncomingWebhook,
  listIncomingWebhooks,
  useAuthStore,
  useChannelStore,
  useMemberStore,
  useUsersStore,
} from '@meza/core';
import {
  CopyIcon,
  PaperPlaneRightIcon,
  PlusIcon,
  TrashIcon,
  WarningIcon,
} from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

interface IncomingWebhookManagementProps {
  serverId: string;
  /** When provided, filter webhooks by this bot user. */
  botUserId?: string;
}

export function IncomingWebhookManagement({
  serverId,
  botUserId,
}: IncomingWebhookManagementProps) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const members = useMemberStore((s) => s.byServer[serverId] ?? []);
  const profiles = useUsersStore((s) => s.profiles);
  const channels = useChannelStore((s) => s.byServer[serverId] ?? []);

  const [webhooks, setWebhooks] = useState<IncomingWebhook[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newBotId, setNewBotId] = useState(botUserId ?? '');
  const [newChannelId, setNewChannelId] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  // Secret display (shown once after creation)
  const [createdWebhook, setCreatedWebhook] = useState<{
    id: string;
    url: string;
    secret: string;
  } | null>(null);

  // Delete confirmation
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Test state
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    id: string;
    success: boolean;
    message: string;
  } | null>(null);

  // Bot members for the select dropdown
  const botMembers = members.filter((m) => profiles[m.userId]?.isBot);

  useEffect(() => {
    if (!isAuthenticated || !serverId) return;
    setIsLoading(true);
    setError('');
    listIncomingWebhooks(serverId)
      .then((result) => {
        const filtered = botUserId
          ? result.filter((w) => w.botUserId === botUserId)
          : result;
        setWebhooks(filtered);
      })
      .catch(() => setError('Failed to load incoming webhooks'))
      .finally(() => setIsLoading(false));
  }, [serverId, isAuthenticated, botUserId]);

  function buildWebhookUrl(webhookId: string): string {
    const base = getBaseUrl() || window.location.origin;
    return `${base}/api/webhooks/incoming/${webhookId}`;
  }

  async function handleCreate() {
    if (!newBotId || !newChannelId) return;
    setCreateError('');
    setIsCreating(true);
    try {
      const result = await createIncomingWebhook(
        newBotId,
        serverId,
        newChannelId,
      );
      if (result?.webhook) {
        const wh = result.webhook;
        setWebhooks((prev) => [...prev, wh]);
        setCreatedWebhook({
          id: result.webhook.id,
          url: buildWebhookUrl(result.webhook.id),
          secret: result.secret,
        });
      }
      setNewChannelId('');
      setShowCreate(false);
    } catch (err) {
      setCreateError(
        err instanceof Error
          ? err.message
          : 'Failed to create incoming webhook',
      );
    } finally {
      setIsCreating(false);
    }
  }

  async function handleDelete(webhookId: string) {
    setIsDeleting(true);
    try {
      await deleteIncomingWebhook(webhookId);
      setWebhooks((prev) => prev.filter((w) => w.id !== webhookId));
      setDeleteConfirmId(null);
    } catch {
      setError('Failed to delete incoming webhook');
    } finally {
      setIsDeleting(false);
    }
  }

  async function handleTest(webhookId: string) {
    setTestingId(webhookId);
    setTestResult(null);
    try {
      const url = buildWebhookUrl(webhookId);
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Test message from incoming webhook management.',
        }),
      });
      if (resp.ok) {
        setTestResult({
          id: webhookId,
          success: true,
          message: 'Test message sent successfully.',
        });
      } else {
        setTestResult({
          id: webhookId,
          success: false,
          message: `Failed: ${resp.status} ${resp.statusText}`,
        });
      }
    } catch {
      setTestResult({
        id: webhookId,
        success: false,
        message: 'Network error sending test message.',
      });
    } finally {
      setTestingId(null);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).catch(() => {});
  }

  return (
    <div>
      {/* E2EE warning */}
      <div className="mb-3 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2">
        <WarningIcon
          size={14}
          className="mt-0.5 flex-shrink-0 text-warning"
          aria-hidden="true"
        />
        <p className="text-xs text-warning">
          Messages via incoming webhooks are not end-to-end encrypted.
        </p>
      </div>

      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
          Incoming Webhooks
        </h4>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs font-medium text-black hover:bg-accent/80"
        >
          <PlusIcon size={12} aria-hidden="true" />
          Create
        </button>
      </div>

      {error && <p className="mb-2 text-xs text-error">{error}</p>}

      {isLoading && (
        <p className="text-xs text-text-muted">Loading incoming webhooks...</p>
      )}

      {/* Create form */}
      {showCreate && (
        <div className="mb-3 rounded-md border border-border bg-bg-elevated p-3">
          <div className="flex flex-col gap-2">
            {!botUserId && (
              <div>
                {/* biome-ignore lint/a11y/noLabelWithoutControl: select follows label */}
                <label className="block text-xs font-medium text-text-muted">
                  Bot
                </label>
                <select
                  value={newBotId}
                  onChange={(e) => setNewBotId(e.target.value)}
                  className="mt-1 w-full rounded-md border border-border bg-bg-surface px-2 py-1.5 text-sm text-text focus:border-accent focus:outline-none"
                >
                  <option value="">Select a bot...</option>
                  {botMembers.map((m) => {
                    const p = profiles[m.userId];
                    return (
                      <option key={m.userId} value={m.userId}>
                        {p?.displayName || p?.username || m.userId.slice(0, 8)}
                      </option>
                    );
                  })}
                </select>
              </div>
            )}
            <div>
              {/* biome-ignore lint/a11y/noLabelWithoutControl: select follows label */}
              <label className="block text-xs font-medium text-text-muted">
                Channel
              </label>
              <select
                value={newChannelId}
                onChange={(e) => setNewChannelId(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-bg-surface px-2 py-1.5 text-sm text-text focus:border-accent focus:outline-none"
              >
                <option value="">Select a channel...</option>
                {channels.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    #{ch.name}
                  </option>
                ))}
              </select>
            </div>
            {createError && <p className="text-xs text-error">{createError}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowCreate(false);
                  setCreateError('');
                }}
                className="rounded-md bg-bg-surface px-2 py-1 text-xs text-text-muted hover:text-text"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={isCreating || !newBotId || !newChannelId}
                className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-black hover:bg-accent/80 disabled:opacity-50"
              >
                {isCreating ? 'Creating...' : 'Create Webhook'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Secret & URL display (shown once after creation) */}
      {createdWebhook && (
        <div className="mb-3 rounded-md border border-warning/30 bg-warning/5 p-3">
          <p className="text-xs font-medium text-warning">
            Webhook created (details shown once)
          </p>
          <div className="mt-2">
            <span className="block text-[10px] font-medium text-text-muted">
              URL
            </span>
            <div className="mt-0.5 flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-bg-surface px-2 py-1 text-xs text-text font-mono">
                {createdWebhook.url}
              </code>
              <button
                type="button"
                onClick={() => copyToClipboard(createdWebhook.url)}
                className="rounded-md p-1 text-text-muted hover:text-text"
                title="Copy URL"
              >
                <CopyIcon size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
          {createdWebhook.secret && (
            <div className="mt-2">
              <span className="block text-[10px] font-medium text-text-muted">
                Secret
              </span>
              <div className="mt-0.5 flex items-center gap-2">
                <code className="flex-1 break-all rounded bg-bg-surface px-2 py-1 text-xs text-text font-mono">
                  {createdWebhook.secret}
                </code>
                <button
                  type="button"
                  onClick={() => copyToClipboard(createdWebhook.secret)}
                  className="rounded-md p-1 text-text-muted hover:text-text"
                  title="Copy secret"
                >
                  <CopyIcon size={14} aria-hidden="true" />
                </button>
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={() => setCreatedWebhook(null)}
            className="mt-2 text-xs text-text-muted hover:text-text"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Webhook list */}
      {!isLoading && webhooks.length === 0 && !showCreate && (
        <p className="text-xs text-text-muted">No incoming webhooks.</p>
      )}

      {webhooks.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {webhooks.map((wh) => {
            const botProfile = profiles[wh.botUserId];
            const botName =
              botProfile?.displayName ||
              botProfile?.username ||
              wh.botUserId.slice(0, 8);
            const channel = channels.find((c) => c.id === wh.channelId);
            const channelName = channel ? `#${channel.name}` : wh.channelId;
            const webhookUrl = buildWebhookUrl(wh.id);
            const createdDate = wh.createdAt
              ? new Date(
                  Number(wh.createdAt.seconds) * 1000,
                ).toLocaleDateString(undefined, {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })
              : 'Unknown';

            return (
              <div
                key={wh.id}
                className="rounded-md border border-border bg-bg-elevated p-2"
              >
                <div className="flex items-center justify-between">
                  <div className="min-w-0 flex-1">
                    {!botUserId && (
                      <span className="block truncate text-xs font-medium text-text">
                        {botName}
                      </span>
                    )}
                    <span className="block truncate text-xs text-accent">
                      {channelName}
                    </span>
                    <span className="block text-[10px] text-text-subtle">
                      Created {createdDate}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => copyToClipboard(webhookUrl)}
                      className="rounded-md p-1 text-text-muted hover:text-text transition-colors"
                      title="Copy webhook URL"
                    >
                      <CopyIcon size={14} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleTest(wh.id)}
                      disabled={testingId === wh.id}
                      className="rounded-md p-1 text-text-muted hover:text-accent transition-colors disabled:opacity-50"
                      title="Send test message"
                    >
                      <PaperPlaneRightIcon size={14} aria-hidden="true" />
                    </button>
                    {deleteConfirmId === wh.id ? (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          disabled={isDeleting}
                          onClick={() => handleDelete(wh.id)}
                          className="rounded-md bg-error px-2 py-0.5 text-xs font-medium text-white hover:bg-error/80 disabled:opacity-50"
                        >
                          {isDeleting ? '...' : 'Confirm'}
                        </button>
                        <button
                          type="button"
                          disabled={isDeleting}
                          onClick={() => setDeleteConfirmId(null)}
                          className="rounded-md px-1 py-0.5 text-xs text-text-muted hover:text-text"
                        >
                          No
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setDeleteConfirmId(wh.id)}
                        className="rounded-md p-1 text-text-muted hover:text-error transition-colors"
                        title="Delete webhook"
                      >
                        <TrashIcon size={14} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Webhook URL display */}
                <div className="mt-1 flex items-center gap-1">
                  <code className="flex-1 truncate rounded bg-bg-surface px-1.5 py-0.5 text-[10px] text-text-muted font-mono">
                    {webhookUrl}
                  </code>
                </div>

                {/* Test result */}
                {testResult?.id === wh.id && (
                  <p
                    className={`mt-1 text-[10px] ${testResult.success ? 'text-success' : 'text-error'}`}
                  >
                    {testResult.message}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
