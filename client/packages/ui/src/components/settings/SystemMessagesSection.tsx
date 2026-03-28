import {
  type Channel,
  ChannelType,
  getSystemMessageConfig,
  listChannels,
  type ServerSystemMessageConfig,
  updateSystemMessageConfig,
  useAuthStore,
  useChannelStore,
} from '@meza/core';
import { useEffect, useMemo, useState } from 'react';

interface SystemMessagesSectionProps {
  serverId: string;
}

const TEMPLATE_MAX_LEN = 512;

interface EventConfig {
  key: string;
  label: string;
  enabledField: keyof Pick<
    ServerSystemMessageConfig,
    | 'joinEnabled'
    | 'leaveEnabled'
    | 'kickEnabled'
    | 'banEnabled'
    | 'timeoutEnabled'
  >;
  templateField: keyof Pick<
    ServerSystemMessageConfig,
    | 'joinTemplate'
    | 'leaveTemplate'
    | 'kickTemplate'
    | 'banTemplate'
    | 'timeoutTemplate'
  >;
  variables: string[];
  placeholder: string;
}

const WELCOME_EVENTS: EventConfig[] = [
  {
    key: 'join',
    label: 'Member Join',
    enabledField: 'joinEnabled',
    templateField: 'joinTemplate',
    variables: ['{user}'],
    placeholder: '{user} joined the server',
  },
  {
    key: 'leave',
    label: 'Member Leave',
    enabledField: 'leaveEnabled',
    templateField: 'leaveTemplate',
    variables: ['{user}'],
    placeholder: '{user} left the server',
  },
];

const MOD_LOG_EVENTS: EventConfig[] = [
  {
    key: 'kick',
    label: 'Member Kick',
    enabledField: 'kickEnabled',
    templateField: 'kickTemplate',
    variables: ['{user}', '{actor}', '{reason}'],
    placeholder: '{user} was kicked by {actor}',
  },
  {
    key: 'ban',
    label: 'Member Ban',
    enabledField: 'banEnabled',
    templateField: 'banTemplate',
    variables: ['{user}', '{actor}', '{reason}'],
    placeholder: '{user} was banned by {actor}',
  },
  {
    key: 'timeout',
    label: 'Member Timeout',
    enabledField: 'timeoutEnabled',
    templateField: 'timeoutTemplate',
    variables: ['{user}', '{actor}', '{reason}', '{duration}'],
    placeholder: '{user} was timed out by {actor} for {duration}',
  },
];

const EMPTY_CHANNELS: never[] = [];

export function SystemMessagesSection({
  serverId,
}: SystemMessagesSectionProps) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const channels = useChannelStore(
    (s) => s.byServer[serverId] ?? EMPTY_CHANNELS,
  );

  const [config, setConfig] = useState<Partial<ServerSystemMessageConfig>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Text channels for dropdowns
  const textChannels = useMemo(
    () => channels.filter((c) => !c.isPrivate && c.type === ChannelType.TEXT),
    [channels],
  );

  function getTemplate(field: EventConfig['templateField']): string {
    return config[field] ?? '';
  }

  const hasOverLimitTemplate = [
    ...WELCOME_EVENTS,
    ...MOD_LOG_EVENTS,
  ].some((evt) => getTemplate(evt.templateField).length > TEMPLATE_MAX_LEN);

  // Fetch config + channels on mount
  useEffect(() => {
    if (!isAuthenticated || !serverId) return;
    listChannels(serverId).catch(() => {});
    getSystemMessageConfig(serverId)
      .then((cfg) => {
        if (cfg) setConfig(cfg);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [serverId, isAuthenticated]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      const result = await updateSystemMessageConfig(serverId, {
        welcomeChannelId: config.welcomeChannelId ?? '',
        modLogChannelId: config.modLogChannelId ?? '',
        joinEnabled: config.joinEnabled,
        joinTemplate: config.joinTemplate ?? '',
        leaveEnabled: config.leaveEnabled,
        leaveTemplate: config.leaveTemplate ?? '',
        kickEnabled: config.kickEnabled,
        kickTemplate: config.kickTemplate ?? '',
        banEnabled: config.banEnabled,
        banTemplate: config.banTemplate ?? '',
        timeoutEnabled: config.timeoutEnabled,
        timeoutTemplate: config.timeoutTemplate ?? '',
      });
      if (result) setConfig(result);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-sm text-text-muted">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-text">System Messages</h2>
      <p className="text-sm text-text-muted">
        Configure where system messages are posted and what text they display.
      </p>

      {/* Welcome Channel Card */}
      <ChannelCard
        title="Welcome Channel"
        description="Where join and leave messages appear."
        channelId={config.welcomeChannelId}
        onChannelChange={(id) =>
          setConfig((prev) => ({ ...prev, welcomeChannelId: id || undefined }))
        }
        textChannels={textChannels}
        events={WELCOME_EVENTS}
        config={config}
        onConfigChange={setConfig}
      />

      {/* Mod Log Channel Card */}
      <ChannelCard
        title="Mod Log Channel"
        description="Where moderation actions are logged."
        channelId={config.modLogChannelId}
        onChannelChange={(id) =>
          setConfig((prev) => ({ ...prev, modLogChannelId: id || undefined }))
        }
        textChannels={textChannels}
        events={MOD_LOG_EVENTS}
        config={config}
        onConfigChange={setConfig}
      />

      {/* Error / Success */}
      {error && <p className="text-xs text-error">{error}</p>}
      {success && (
        <p className="text-xs text-accent">Settings saved successfully</p>
      )}

      {/* Save */}
      <button
        type="button"
        onClick={handleSave}
        disabled={saving || hasOverLimitTemplate}
        className="rounded-md bg-accent px-6 py-2 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-50"
      >
        {saving ? 'Saving...' : 'Save Changes'}
      </button>
    </div>
  );
}

function ChannelCard({
  title,
  description,
  channelId,
  onChannelChange,
  textChannels,
  events,
  config,
  onConfigChange,
}: {
  title: string;
  description: string;
  channelId: string | undefined;
  onChannelChange: (id: string) => void;
  textChannels: Channel[];
  events: EventConfig[];
  config: Partial<ServerSystemMessageConfig>;
  onConfigChange: (
    fn: (
      prev: Partial<ServerSystemMessageConfig>,
    ) => Partial<ServerSystemMessageConfig>,
  ) => void;
}) {
  return (
    <div className="rounded-lg border border-border p-4 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-text">{title}</h3>
        <p className="text-xs text-text-muted">{description}</p>
      </div>

      {/* Channel dropdown */}
      <div>
        <label
          htmlFor={`sysmsg-channel-${title}`}
          className="mb-1 block text-xs font-medium text-text-muted"
        >
          Channel
        </label>
        <select
          id={`sysmsg-channel-${title}`}
          value={channelId ?? ''}
          onChange={(e) => onChannelChange(e.target.value)}
          className="w-full rounded-md border border-border bg-bg-surface px-3 py-1.5 text-sm text-text focus:border-accent focus:outline-none"
        >
          <option value="">Default (first text channel)</option>
          {textChannels.map((ch) => (
            <option key={ch.id} value={ch.id}>
              #{ch.name}
            </option>
          ))}
        </select>
      </div>

      {/* Event toggles + templates */}
      {events.map((evt) => (
        <EventRow
          key={evt.key}
          event={evt}
          enabled={config[evt.enabledField] !== false}
          template={getTemplate(evt.templateField)}
          onEnabledChange={(v) =>
            onConfigChange((prev) => ({ ...prev, [evt.enabledField]: v }))
          }
          onTemplateChange={(v) =>
            onConfigChange((prev) => ({
              ...prev,
              [evt.templateField]: v || undefined,
            }))
          }
        />
      ))}
    </div>
  );
}

function EventRow({
  event,
  enabled,
  template,
  onEnabledChange,
  onTemplateChange,
}: {
  event: EventConfig;
  enabled: boolean;
  template: string;
  onEnabledChange: (v: boolean) => void;
  onTemplateChange: (v: string) => void;
}) {
  const overLimit = template.length > TEMPLATE_MAX_LEN;

  return (
    <div className="space-y-1.5">
      {/* Toggle */}
      <div className="flex items-center justify-between">
        <span className="text-sm text-text">{event.label}</span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => onEnabledChange(!enabled)}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors ${
            enabled ? 'bg-accent' : 'bg-bg-surface'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
              enabled ? 'translate-x-4.5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      {/* Template input */}
      {enabled && (
        <div>
          <input
            type="text"
            value={template}
            onChange={(e) => onTemplateChange(e.target.value)}
            placeholder={event.placeholder}
            className="w-full rounded-md border border-border bg-bg-surface px-3 py-1.5 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
          <div className="mt-0.5 flex items-center justify-between text-xs text-text-subtle">
            <span>Variables: {event.variables.join(', ')}</span>
            {template && (
              <span className={overLimit ? 'text-error' : ''}>
                {template.length}/{TEMPLATE_MAX_LEN}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
