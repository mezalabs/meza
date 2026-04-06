import {
  createWebhook,
  deleteWebhook,
  getAppOrigin,
  listChannelWebhooks,
  listWebhookDeliveries,
  regenerateWebhookToken,
  updateWebhook,
} from '@meza/core';
import {
  ArrowClockwiseIcon,
  CaretRightIcon,
  CopyIcon,
  PlusIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';

type WebhookItem = Awaited<ReturnType<typeof listChannelWebhooks>>[number];
type DeliveryItem = Awaited<ReturnType<typeof listWebhookDeliveries>>[number];

interface WebhooksSectionProps {
  serverId: string;
  channelId: string;
}

export function WebhooksSection({ channelId }: WebhooksSectionProps) {
  const [webhooks, setWebhooks] = useState<WebhookItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const loadWebhooks = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await listChannelWebhooks(channelId);
      setWebhooks(result);
    } catch {
      setError('Failed to load webhooks');
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    loadWebhooks();
  }, [loadWebhooks]);

  return (
    <div className="max-w-lg space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
          Webhooks
        </h2>
        {!showCreate && (
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-black hover:bg-accent-hover"
          >
            <PlusIcon size={16} aria-hidden="true" />
            Create Webhook
          </button>
        )}
      </div>

      {showCreate && (
        <CreateWebhookForm
          channelId={channelId}
          onCreated={loadWebhooks}
          onClose={() => setShowCreate(false)}
        />
      )}

      {error && <p className="text-sm text-error">{error}</p>}

      {loading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-lg bg-bg-surface"
            />
          ))}
        </div>
      ) : webhooks.length === 0 ? (
        <p className="text-sm text-text-muted">
          No webhooks yet. Create one to allow external services to post
          messages to this channel.
        </p>
      ) : (
        <div className="space-y-3">
          {webhooks.map((webhook) => (
            <WebhookCard
              key={webhook.id}
              webhook={webhook}
              onUpdate={loadWebhooks}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CreateWebhookForm({
  channelId,
  onCreated,
  onClose,
}: {
  channelId: string;
  onCreated: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<{ token: string; url: string } | null>(
    null,
  );
  const [error, setError] = useState('');

  const handleCreate = async () => {
    setCreating(true);
    setError('');
    try {
      const res = await createWebhook(channelId, name);
      setResult({ token: res.token, url: res.url });
      onCreated();
    } catch {
      setError('Failed to create webhook');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-bg-surface p-4 space-y-3">
      {result ? (
        <>
          <p className="text-sm font-medium text-text">Webhook created!</p>
          <p className="text-xs text-text-muted">
            Copy the URL below. It won't be shown again.
          </p>
          <CopyField
            value={`${getAppOrigin()}${result.url}`}
            label="Webhook URL"
          />

          <div className="space-y-2 rounded-md border border-border bg-bg-base p-3">
            <p className="text-xs font-medium text-text">Usage</p>
            <p className="text-xs text-text-muted">
              Send a{' '}
              <code className="rounded bg-bg-tertiary px-1 py-0.5 text-text">
                POST
              </code>{' '}
              request with a JSON body to the URL above.
            </p>
            <pre className="overflow-x-auto rounded bg-bg-tertiary px-3 py-2 text-xs text-text font-mono leading-relaxed">
              {`curl -X POST ${getAppOrigin()}${result.url} \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify({ content: 'Hello from a webhook!' }, null, 2)}'`}
            </pre>
            <details className="group">
              <summary className="cursor-pointer text-xs text-text-muted hover:text-text">
                <span className="ml-0.5">All fields</span>
              </summary>
              <div className="mt-2 space-y-1 text-xs text-text-muted">
                <p>
                  <code className="rounded bg-bg-tertiary px-1 py-0.5 text-text">
                    content
                  </code>{' '}
                  — message text (required if no embeds)
                </p>
                <p>
                  <code className="rounded bg-bg-tertiary px-1 py-0.5 text-text">
                    username
                  </code>{' '}
                  — override display name
                </p>
                <p>
                  <code className="rounded bg-bg-tertiary px-1 py-0.5 text-text">
                    avatar_url
                  </code>{' '}
                  — override avatar (HTTPS only)
                </p>
                <p>
                  <code className="rounded bg-bg-tertiary px-1 py-0.5 text-text">
                    embeds
                  </code>{' '}
                  — array of rich embeds (max 10)
                </p>
              </div>
            </details>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-black hover:bg-accent-hover"
          >
            Done
          </button>
        </>
      ) : (
        <>
          <div className="space-y-1.5">
            <label
              htmlFor="webhook-name"
              className="block text-xs text-text-muted"
            >
              Name
            </label>
            <input
              ref={(el) => el?.focus()}
              id="webhook-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder="e.g. GitHub"
              className="w-full rounded-md border border-border bg-bg-base px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:border-accent focus:outline-none"
            />
          </div>
          {error && <p className="text-xs text-error">{error}</p>}
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!name.trim() || creating}
              onClick={handleCreate}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-50"
            >
              {creating ? 'Creating...' : 'Create'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-sm text-text-muted hover:text-text"
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function WebhookCard({
  webhook,
  onUpdate,
}: {
  webhook: WebhookItem;
  onUpdate: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showToken, setShowToken] = useState<{
    token: string;
    url: string;
  } | null>(null);
  const [showDeliveries, setShowDeliveries] = useState(false);
  const [deliveries, setDeliveries] = useState<DeliveryItem[]>([]);
  const [loadingDeliveries, setLoadingDeliveries] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(webhook.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleDelete = async () => {
    if (!window.confirm('Delete this webhook? This cannot be undone.')) return;
    setDeleting(true);
    setError('');
    try {
      await deleteWebhook(webhook.id);
      onUpdate();
    } catch {
      setError('Failed to delete webhook');
      setDeleting(false);
    }
  };

  const handleRegenerate = async () => {
    if (
      !window.confirm(
        'Regenerate token? The current URL will stop working immediately.',
      )
    )
      return;
    setRegenerating(true);
    setError('');
    try {
      const res = await regenerateWebhookToken(webhook.id);
      setShowToken({ token: res.token, url: res.url });
    } catch {
      setError('Failed to regenerate token');
    } finally {
      setRegenerating(false);
    }
  };

  const handleSaveEdit = async () => {
    setSaving(true);
    setError('');
    try {
      await updateWebhook(webhook.id, editName);
      onUpdate();
      setEditing(false);
    } catch {
      setError('Failed to save webhook');
    } finally {
      setSaving(false);
    }
  };

  const handleLoadDeliveries = async () => {
    if (showDeliveries) {
      setShowDeliveries(false);
      return;
    }
    setLoadingDeliveries(true);
    setError('');
    try {
      const result = await listWebhookDeliveries(webhook.id);
      setDeliveries(result);
      setShowDeliveries(true);
    } catch {
      setError('Failed to load delivery logs');
    } finally {
      setLoadingDeliveries(false);
    }
  };

  const createdDate = webhook.createdAt
    ? new Date(Number(webhook.createdAt.seconds) * 1000).toLocaleDateString()
    : '';

  return (
    <div className="rounded-lg border border-border bg-bg-surface overflow-hidden">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-bg-tertiary/30"
        onClick={() => setExpanded(!expanded)}
      >
        <CaretRightIcon
          size={16}
          className={`shrink-0 text-text-muted transition-transform ${expanded ? 'rotate-90' : ''}`}
          aria-hidden="true"
        />
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent/20 text-accent text-xs font-bold shrink-0">
          {webhook.name.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium text-text truncate">
            {webhook.name}
          </div>
          <div className="text-xs text-text-muted">Created {createdDate}</div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border px-4 py-3 space-y-3">
          {/* Edit name */}
          {editing ? (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                maxLength={80}
                className="flex-1 rounded-md border border-border bg-bg-base px-2 py-1 text-sm text-text focus:border-accent focus:outline-none"
              />
              <button
                type="button"
                disabled={!editName.trim() || saving}
                onClick={handleSaveEdit}
                className="rounded px-2 py-1 text-xs bg-accent text-black hover:bg-accent-hover disabled:opacity-50"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setEditName(webhook.name);
                }}
                className="rounded px-2 py-1 text-xs text-text-muted hover:text-text"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-xs text-accent hover:underline"
            >
              Edit Name
            </button>
          )}

          {error && <p className="text-xs text-error">{error}</p>}

          {/* Show regenerated token */}
          {showToken && (
            <div className="space-y-1">
              <p className="text-xs text-text-muted">
                New token generated. Copy it now — it won't be shown again.
              </p>
              <CopyField
                value={`${getAppOrigin()}${showToken.url}`}
                label="Webhook URL"
              />
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={regenerating}
              onClick={handleRegenerate}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-text-muted hover:text-text hover:bg-bg-tertiary"
            >
              <ArrowClockwiseIcon size={14} aria-hidden="true" />
              {regenerating ? 'Regenerating...' : 'Regenerate Token'}
            </button>
            <button
              type="button"
              onClick={handleLoadDeliveries}
              disabled={loadingDeliveries}
              className="rounded px-2 py-1 text-xs text-text-muted hover:text-text hover:bg-bg-tertiary"
            >
              {loadingDeliveries
                ? 'Loading...'
                : showDeliveries
                  ? 'Hide Logs'
                  : 'Delivery Logs'}
            </button>
            <button
              type="button"
              disabled={deleting}
              onClick={handleDelete}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-error hover:bg-error/10"
            >
              <TrashIcon size={14} aria-hidden="true" />
              {deleting ? 'Deleting...' : 'Delete'}
            </button>
          </div>

          {/* Delivery logs */}
          {showDeliveries && (
            <div className="space-y-1">
              <h4 className="text-xs font-semibold text-text-subtle uppercase">
                Recent Deliveries
              </h4>
              {deliveries.length === 0 ? (
                <p className="text-xs text-text-muted">No deliveries yet.</p>
              ) : (
                <div className="max-h-48 overflow-y-auto space-y-1">
                  {deliveries.map((d) => (
                    <div
                      key={d.id}
                      className={`flex items-center justify-between rounded px-2 py-1 text-xs ${
                        d.success ? 'bg-success/10' : 'bg-error/10'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`font-mono ${d.success ? 'text-success' : 'text-error'}`}
                        >
                          {d.success ? 'OK' : d.errorCode}
                        </span>
                        <span className="text-text-muted truncate">
                          {d.createdAt
                            ? new Date(
                                Number(d.createdAt.seconds) * 1000,
                              ).toLocaleString()
                            : ''}
                        </span>
                      </div>
                      <span className="text-text-subtle shrink-0">
                        {d.latencyMs}ms
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 rounded bg-bg-tertiary px-2 py-1 text-xs text-text font-mono truncate">
        {value}
      </code>
      <button
        type="button"
        onClick={handleCopy}
        className="shrink-0 rounded p-1 text-text-muted hover:text-text hover:bg-bg-tertiary"
        title={label}
      >
        {copied ? (
          <span className="text-xs text-success">Copied!</span>
        ) : (
          <CopyIcon size={16} aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
