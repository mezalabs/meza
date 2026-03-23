import {
  createWebhook,
  deleteWebhook,
  listWebhooks,
  useAuthStore,
  useMemberStore,
  useUsersStore,
  type Webhook,
} from '@meza/core';
import { CopyIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

interface OutgoingWebhookManagementProps {
  serverId: string;
  /** When provided, filter webhooks by this bot user. */
  botUserId?: string;
}

export function OutgoingWebhookManagement({
  serverId,
  botUserId,
}: OutgoingWebhookManagementProps) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const members = useMemberStore((s) => s.byServer[serverId] ?? []);
  const profiles = useUsersStore((s) => s.profiles);

  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newBotId, setNewBotId] = useState(botUserId ?? '');
  const [newUrl, setNewUrl] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  // Secret display (shown once after creation)
  const [createdSecret, setCreatedSecret] = useState<{
    id: string;
    secret: string;
  } | null>(null);

  // Delete confirmation
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Bot members for the select dropdown
  const botMembers = members.filter((m) => profiles[m.userId]?.isBot);

  useEffect(() => {
    if (!isAuthenticated || !serverId) return;
    setIsLoading(true);
    setError('');
    listWebhooks(serverId)
      .then((result) => {
        const filtered = botUserId
          ? result.filter((w) => w.botUserId === botUserId)
          : result;
        setWebhooks(filtered);
      })
      .catch(() => setError('Failed to load webhooks'))
      .finally(() => setIsLoading(false));
  }, [serverId, isAuthenticated, botUserId]);

  async function handleCreate() {
    if (!newBotId || !newUrl.trim()) return;
    setCreateError('');
    setIsCreating(true);
    try {
      const webhook = await createWebhook(newBotId, serverId, newUrl.trim());
      if (webhook) {
        setWebhooks((prev) => [...prev, webhook]);
        if (webhook.secret) {
          setCreatedSecret({ id: webhook.id, secret: webhook.secret });
        }
      }
      setNewUrl('');
      setShowCreate(false);
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : 'Failed to create webhook',
      );
    } finally {
      setIsCreating(false);
    }
  }

  async function handleDelete(webhookId: string) {
    setIsDeleting(true);
    try {
      await deleteWebhook(webhookId);
      setWebhooks((prev) => prev.filter((w) => w.id !== webhookId));
      setDeleteConfirmId(null);
    } catch {
      setError('Failed to delete webhook');
    } finally {
      setIsDeleting(false);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).catch(() => {});
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
          Outgoing Webhooks
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
        <p className="text-xs text-text-muted">Loading webhooks...</p>
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
              {/* biome-ignore lint/a11y/noLabelWithoutControl: input follows label */}
              <label className="block text-xs font-medium text-text-muted">
                Destination URL
              </label>
              <input
                type="url"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                placeholder="https://example.com/webhook"
                disabled={isCreating}
                className="mt-1 w-full rounded-md border border-border bg-bg-surface px-2 py-1.5 text-sm text-text placeholder:text-text-subtle focus:border-accent focus:outline-none disabled:opacity-50"
              />
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
                disabled={isCreating || !newBotId || !newUrl.trim()}
                className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-black hover:bg-accent/80 disabled:opacity-50"
              >
                {isCreating ? 'Creating...' : 'Create Webhook'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Secret display (shown once after creation) */}
      {createdSecret && (
        <div className="mb-3 rounded-md border border-warning/30 bg-warning/5 p-3">
          <p className="text-xs font-medium text-warning">
            Webhook secret (shown once)
          </p>
          <div className="mt-1 flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-bg-surface px-2 py-1 text-xs text-text font-mono">
              {createdSecret.secret}
            </code>
            <button
              type="button"
              onClick={() => copyToClipboard(createdSecret.secret)}
              className="rounded-md p-1 text-text-muted hover:text-text"
              title="Copy secret"
            >
              <CopyIcon size={14} aria-hidden="true" />
            </button>
          </div>
          <button
            type="button"
            onClick={() => setCreatedSecret(null)}
            className="mt-2 text-xs text-text-muted hover:text-text"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Webhook list */}
      {!isLoading && webhooks.length === 0 && !showCreate && (
        <p className="text-xs text-text-muted">No outgoing webhooks.</p>
      )}

      {webhooks.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {webhooks.map((wh) => {
            const botProfile = profiles[wh.botUserId];
            const botName =
              botProfile?.displayName ||
              botProfile?.username ||
              wh.botUserId.slice(0, 8);
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
                className="flex items-center justify-between rounded-md border border-border bg-bg-elevated p-2"
              >
                <div className="min-w-0 flex-1">
                  {!botUserId && (
                    <span className="block truncate text-xs font-medium text-text">
                      {botName}
                    </span>
                  )}
                  <span className="block truncate text-xs text-text-muted">
                    {wh.url}
                  </span>
                  <span className="block text-[10px] text-text-subtle">
                    Created {createdDate}
                  </span>
                </div>
                <div>
                  {deleteConfirmId === wh.id ? (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        disabled={isDeleting}
                        onClick={() => handleDelete(wh.id)}
                        className="rounded-md bg-error px-2 py-0.5 text-xs font-medium text-white hover:bg-error/80 disabled:opacity-50"
                      >
                        {isDeleting ? 'Deleting...' : 'Confirm'}
                      </button>
                      <button
                        type="button"
                        disabled={isDeleting}
                        onClick={() => setDeleteConfirmId(null)}
                        className="rounded-md px-2 py-0.5 text-xs text-text-muted hover:text-text"
                      >
                        Cancel
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
            );
          })}
        </div>
      )}
    </div>
  );
}
