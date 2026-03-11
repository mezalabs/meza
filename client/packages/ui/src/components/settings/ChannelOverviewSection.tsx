import {
  updateChannel,
  useChannelGroupStore,
  useChannelStore,
} from '@meza/core';
import { useEffect, useMemo, useState } from 'react';

interface ChannelOverviewSectionProps {
  serverId: string;
  channelId: string;
}

const SLOW_MODE_OPTIONS = [
  { label: 'Off', value: null },
  { label: '5s', value: 5 },
  { label: '10s', value: 10 },
  { label: '15s', value: 15 },
  { label: '30s', value: 30 },
  { label: '1m', value: 60 },
  { label: '2m', value: 120 },
  { label: '5m', value: 300 },
  { label: '10m', value: 600 },
  { label: '15m', value: 900 },
  { label: '30m', value: 1800 },
  { label: '1h', value: 3600 },
  { label: '2h', value: 7200 },
  { label: '6h', value: 21600 },
  { label: 'Read-only', value: 0 },
] as const;

export function ChannelOverviewSection({
  serverId,
  channelId,
}: ChannelOverviewSectionProps) {
  const channels = useChannelStore((s) => s.byServer[serverId]);
  const channel = useMemo(
    () => channels?.find((c) => c.id === channelId),
    [channels, channelId],
  );
  const groups = useChannelGroupStore((s) => s.byServer[serverId] ?? []);

  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [contentWarning, setContentWarning] = useState('');
  const [slowMode, setSlowMode] = useState<number | null>(null);
  const [channelGroupId, setChannelGroupId] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  // Sync form state from channel data.
  useEffect(() => {
    if (!channel) return;
    setName(channel.name);
    setTopic(channel.topic);
    setContentWarning(channel.contentWarning ?? '');
    setSlowMode(
      channel.slowModeSeconds === undefined ? null : channel.slowModeSeconds,
    );
    setChannelGroupId(channel.channelGroupId ?? '');
  }, [channel]);

  if (!channel) {
    return <div className="text-sm text-text-muted">Channel not found</div>;
  }

  const isDirty =
    name !== channel.name ||
    topic !== channel.topic ||
    contentWarning !== (channel.contentWarning ?? '') ||
    slowMode !==
      (channel.slowModeSeconds === undefined
        ? null
        : channel.slowModeSeconds) ||
    channelGroupId !== (channel.channelGroupId ?? '');

  const nameValid = name.trim().length >= 1 && name.trim().length <= 100;
  const topicValid = topic.length <= 1024;
  const cwValid = contentWarning.length <= 256;

  async function handleSave() {
    setIsSaving(true);
    setFeedback(null);
    try {
      await updateChannel(channelId, {
        name: name.trim(),
        topic,
        contentWarning: contentWarning.trim(),
        slowModeSeconds: slowMode ?? undefined,
        channelGroupId: channelGroupId || undefined,
      });
      setFeedback({ type: 'success', message: 'Channel updated' });
    } catch {
      setFeedback({ type: 'error', message: 'Failed to update channel' });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="max-w-lg space-y-6">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
        Overview
      </h2>

      {/* Channel Name */}
      <div className="space-y-1.5">
        <label
          htmlFor="channel-name"
          className="block text-sm font-medium text-text"
        >
          Channel Name
        </label>
        <input
          id="channel-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          className="w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:border-accent focus:outline-none"
          placeholder="channel-name"
        />
        {!nameValid && name.length > 0 && (
          <p className="text-xs text-error">
            Channel name must be 1–100 characters
          </p>
        )}
      </div>

      {/* Topic */}
      <div className="space-y-1.5">
        <label
          htmlFor="channel-topic"
          className="block text-sm font-medium text-text"
        >
          Topic
        </label>
        <textarea
          id="channel-topic"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          maxLength={1024}
          rows={3}
          className="w-full resize-y rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:border-accent focus:outline-none"
          placeholder="Set a topic for this channel"
        />
        <p className="text-xs text-text-subtle">{topic.length}/1024</p>
      </div>

      {/* Content Warning */}
      <div className="space-y-1.5">
        <label
          htmlFor="content-warning"
          className="block text-sm font-medium text-text"
        >
          Content Warning
        </label>
        <input
          id="content-warning"
          type="text"
          value={contentWarning}
          onChange={(e) => setContentWarning(e.target.value)}
          maxLength={256}
          className="w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:border-accent focus:outline-none"
          placeholder="e.g. NSFW, spoilers for Season 3, graphic imagery"
        />
        <p className="text-xs text-text-subtle">
          {contentWarning.length > 0
            ? `${contentWarning.length}/256 — Users will see an interstitial before entering this channel.`
            : 'Leave empty for no warning.'}
        </p>
        {!cwValid && (
          <p className="text-xs text-error">
            Content warning cannot exceed 256 characters
          </p>
        )}
      </div>

      {/* Slow Mode */}
      <div className="space-y-1.5">
        <label
          htmlFor="slow-mode"
          className="block text-sm font-medium text-text"
        >
          Slow Mode
        </label>
        <select
          id="slow-mode"
          value={slowMode === null ? 'off' : String(slowMode)}
          onChange={(e) => {
            setSlowMode(
              e.target.value === 'off' ? null : Number(e.target.value),
            );
          }}
          className="w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
        >
          {SLOW_MODE_OPTIONS.map((opt) => (
            <option
              key={opt.label}
              value={opt.value === null ? 'off' : String(opt.value)}
            >
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Privacy (read-only — set at creation, immutable due to E2EE) */}
      <div className="space-y-1.5">
        <span className="block text-sm font-medium text-text">Privacy</span>
        <p className="text-sm text-text-muted">
          {channel.isPrivate ? 'Private' : 'Public'} — channel privacy is set at
          creation and cannot be changed.
        </p>
      </div>

      {/* Channel Group (Category) */}
      <div className="space-y-1.5">
        <label
          htmlFor="channel-group"
          className="block text-sm font-medium text-text"
        >
          Category
        </label>
        <select
          id="channel-group"
          value={channelGroupId}
          onChange={(e) => setChannelGroupId(e.target.value)}
          className="w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
        >
          <option value="">None</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        {channelGroupId !== (channel.channelGroupId ?? '') &&
          channelGroupId !== '' && (
            <p className="text-xs text-text-subtle">
              Changing category may affect inherited permission overrides.
            </p>
          )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={
            !isDirty || !nameValid || !topicValid || !cwValid || isSaving
          }
          onClick={handleSave}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSaving ? 'Saving...' : 'Save Changes'}
        </button>
        {feedback && (
          <span
            className={`text-sm ${
              feedback.type === 'success' ? 'text-success' : 'text-error'
            }`}
          >
            {feedback.message}
          </span>
        )}
      </div>
    </div>
  );
}
