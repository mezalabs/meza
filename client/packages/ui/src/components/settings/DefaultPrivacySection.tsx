import { getServer, updateServer, useServerStore } from '@meza/core';
import { useEffect, useState } from 'react';

interface DefaultPrivacySectionProps {
  serverId: string;
}

export function DefaultPrivacySection({
  serverId,
}: DefaultPrivacySectionProps) {
  const server = useServerStore((s) => s.servers[serverId]);
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  useEffect(() => {
    getServer(serverId);
  }, [serverId]);

  useEffect(() => {
    if (server) {
      setEnabled(server.defaultChannelPrivacy);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  async function handleToggle() {
    const next = !enabled;
    setEnabled(next);
    setSaving(true);
    setFeedback(null);
    try {
      await updateServer(serverId, { defaultChannelPrivacy: next });
      setFeedback({ type: 'success', message: 'Setting updated.' });
      setTimeout(() => setFeedback(null), 3000);
    } catch (err) {
      setEnabled(!next);
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to save.',
      });
    } finally {
      setSaving(false);
    }
  }

  if (!server) {
    return <div className="text-sm text-text-muted">Loading...</div>;
  }

  return (
    <div className="max-w-md space-y-6">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
        Channel Privacy
      </h2>

      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-text">
            Default to Private Channels
          </div>
          <div className="text-xs text-text-muted">
            New channels will be end-to-end encrypted by default. This setting
            does not affect existing channels.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={handleToggle}
          disabled={saving}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:opacity-50 ${
            enabled ? 'bg-accent' : 'bg-bg-surface'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
              enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {feedback && (
        <output
          className={`block text-sm ${
            feedback.type === 'success' ? 'text-green-400' : 'text-red-400'
          }`}
        >
          {feedback.message}
        </output>
      )}
    </div>
  );
}
