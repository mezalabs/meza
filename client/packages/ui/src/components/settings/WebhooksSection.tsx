import {
  createWebhook,
  deleteWebhook,
  listChannelWebhooks,
  listWebhookDeliveries,
  regenerateWebhookToken,
  updateWebhook,
} from '@meza/core';
import {
  ArrowClockwiseIcon,
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
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
          Webhooks
        </h2>
        <CreateWebhookButton channelId={channelId} onCreated={loadWebhooks} />
      </div>

      {error && <p className="text-sm text-error">{error}</p>}

      {loading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-lg bg-bg-surface" />
          ))}
        </div>
      ) : webhooks.length === 0 ? (
        <p className="text-sm text-text-muted">
          No webhooks yet. Create one to allow external services to post messages to this channel.
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

function CreateWebhookButton({
  channelId,
  onCreated,
}: {
  channelId: string;
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<{ token: string; url: string } | null>(null);
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

  const handleClose = () => {
    setOpen(false);
    setName('');
    setResult(null);
    setError('');
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/80"
      >
        <PlusIcon size={16} aria-hidden="true" />
        Create Webhook
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-bg-surface p-4 space-y-3">
      {result ? (
        <>
          <p className="text-sm font-medium text-text">Webhook created!</p>
          <p className="text-xs text-text-muted">
            Copy the URL below. It will only be shown once.
          </p>
          <CopyField value={result.url} label="Webhook URL" />
          <button
            type="button"
            onClick={handleClose}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/80"
          >
            Done
          </button>
        </>
      ) : (
        <>
          <div className="space-y-1.5">
            <label htmlFor="webhook-name" className="block text-xs text-text-muted">
              Name
            </label>
            <input
              id="webhook-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder="e.g. GitHub"
              autoFocus
              className="w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:border-accent focus:outline-none"
            />
          </div>
          {error && <p className="text-xs text-error">{error}</p>}
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!name.trim() || creating}
              onClick={handleCreate}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/80 disabled:opacity-50"
            >
              {creating ? 'Creating...' : 'Create'}
            </button>
            <button
              type="button"
              onClick={handleClose}
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
  const [showToken, setShowToken] = useState<{ token: string; url: string } | null>(null);
  const [showDeliveries, setShowDeliveries] = useState(false);
  const [deliveries, setDeliveries] = useState<DeliveryItem[]>([]);
  const [loadingDeliveries, setLoadingDeliveries] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(webhook.name);
  const [saving, setSaving] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteWebhook(webhook.id);
      onUpdate();
    } catch {
      setDeleting(false);
    }
  };

  const handleRegenerate = async () => {
    setRegenerating(true);
    try {
      const res = await regenerateWebhookToken(webhook.id);
      setShowToken({ token: res.token, url: res.url });
    } catch {
      // ignore
    } finally {
      setRegenerating(false);
    }
  };

  const handleSaveEdit = async () => {
    setSaving(true);
    try {
      await updateWebhook(webhook.id, editName);
      onUpdate();
      setEditing(false);
    } catch {
      // ignore
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
    try {
      const result = await listWebhookDeliveries(webhook.id);
      setDeliveries(result);
      setShowDeliveries(true);
    } catch {
      // ignore
    } finally {
      setLoadingDeliveries(false);
    }
  };

  const createdDate = webhook.createdAt
    ? new Date(Number(webhook.createdAt.seconds) * 1000).toLocaleDateString()
    : '';

  return (
    <div className="rounded-lg border border-border bg-bg-surface overflow-hidden">
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-bg-tertiary/30"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent/20 text-accent text-xs font-bold flex-shrink-0">
            {webhook.name.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium text-text truncate">{webhook.name}</div>
            <div className="text-xs text-text-muted">Created {createdDate}</div>
          </div>
        </div>
        <span className="text-xs text-text-subtle">{expanded ? 'Collapse' : 'Expand'}</span>
      </div>

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
                className="flex-1 rounded-md border border-border bg-bg-surface px-2 py-1 text-sm text-text focus:border-accent focus:outline-none"
              />
              <button
                type="button"
                disabled={!editName.trim() || saving}
                onClick={handleSaveEdit}
                className="rounded px-2 py-1 text-xs bg-accent text-white hover:bg-accent/80 disabled:opacity-50"
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

          {/* Show regenerated token */}
          {showToken && (
            <div className="space-y-1">
              <p className="text-xs text-text-muted">
                New token generated. Copy it now — it won't be shown again.
              </p>
              <CopyField value={showToken.url} label="Webhook URL" />
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
              {loadingDeliveries ? 'Loading...' : showDeliveries ? 'Hide Logs' : 'Delivery Logs'}
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
                        d.success ? 'bg-green-500/10' : 'bg-error/10'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`font-mono ${d.success ? 'text-green-500' : 'text-error'}`}
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
                      <span className="text-text-subtle flex-shrink-0">
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
        className="flex-shrink-0 rounded p-1 text-text-muted hover:text-text hover:bg-bg-tertiary"
        title={label}
      >
        {copied ? (
          <span className="text-xs text-green-500">Copied!</span>
        ) : (
          <CopyIcon size={16} aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
