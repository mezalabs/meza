import {
  type Channel,
  ChannelType,
  getServer,
  listChannels,
  listRoles,
  type Role,
  updateChannel,
  updateRole,
  updateServer,
  useAuthStore,
  useChannelStore,
  useRoleStore,
  useServerStore,
} from '@meza/core';
import { useEffect, useMemo, useState } from 'react';
import { roleColorHex } from '../../utils/color.ts';

interface OnboardingSectionProps {
  serverId: string;
}

const EMPTY_CHANNELS: never[] = [];
const EMPTY_ROLES: never[] = [];

export function OnboardingSection({ serverId }: OnboardingSectionProps) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const server = useServerStore((s) => s.servers[serverId]);
  const channels = useChannelStore(
    (s) => s.byServer[serverId] ?? EMPTY_CHANNELS,
  );
  const roles = useRoleStore((s) => s.byServer[serverId] ?? EMPTY_ROLES);

  const [onboardingEnabled, setOnboardingEnabled] = useState(false);
  const [welcomeMessage, setWelcomeMessage] = useState('');
  const [rules, setRules] = useState('');
  const [rulesRequired, setRulesRequired] = useState(false);
  const [defaultChannelIds, setDefaultChannelIds] = useState<Set<string>>(
    new Set(),
  );
  const [selfAssignableRoleIds, setSelfAssignableRoleIds] = useState<
    Set<string>
  >(new Set());

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Fetch data on mount
  useEffect(() => {
    if (!isAuthenticated || !serverId) return;
    getServer(serverId);
    listChannels(serverId).catch(() => {});
    listRoles(serverId).catch(() => {});
  }, [serverId, isAuthenticated]);

  // Sync form state from server data
  useEffect(() => {
    if (!server) return;
    setOnboardingEnabled(server.onboardingEnabled);
    setWelcomeMessage(server.welcomeMessage);
    setRules(server.rules);
    setRulesRequired(server.rulesRequired);
  }, [server]);

  // Sync default channels from channel data
  useEffect(() => {
    const ids = new Set<string>();
    for (const ch of channels) {
      if (ch.isDefault) ids.add(ch.id);
    }
    setDefaultChannelIds(ids);
  }, [channels]);

  // Sync self-assignable roles from role data
  useEffect(() => {
    const ids = new Set<string>();
    for (const r of roles) {
      if (r.isSelfAssignable) ids.add(r.id);
    }
    setSelfAssignableRoleIds(ids);
  }, [roles]);

  // Non-private text channels eligible to be default
  const eligibleChannels = useMemo(
    () => channels.filter((c) => !c.isPrivate && c.type === ChannelType.TEXT),
    [channels],
  );

  const rulesLineCount = rules.split('\n').filter((l) => l.trim()).length;
  const welcomeOverLimit = welcomeMessage.length > 5000;
  const rulesOverLimit = rulesLineCount > 25;

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(false);

    try {
      // Save server-level onboarding settings
      await updateServer(serverId, {
        welcomeMessage,
        rules,
        onboardingEnabled,
        rulesRequired: onboardingEnabled ? rulesRequired : false,
      });

      // Update default channels: toggle is_default for changed channels
      const updatePromises: Promise<unknown>[] = [];
      for (const ch of eligibleChannels) {
        const shouldBeDefault = defaultChannelIds.has(ch.id);
        if (ch.isDefault !== shouldBeDefault) {
          updatePromises.push(
            updateChannel(ch.id, { isDefault: shouldBeDefault }),
          );
        }
      }

      // Update self-assignable roles
      for (const r of roles) {
        const shouldBeSelfAssignable = selfAssignableRoleIds.has(r.id);
        if (r.isSelfAssignable !== shouldBeSelfAssignable) {
          updatePromises.push(
            updateRole(r.id, { isSelfAssignable: shouldBeSelfAssignable }),
          );
        }
      }

      await Promise.all(updatePromises);

      // Refetch to sync store
      await Promise.all([listChannels(serverId), listRoles(serverId)]);

      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  if (!server) {
    return <div className="text-sm text-text-muted">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-text">Onboarding</h2>

      {/* Enable toggle */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-text">Enable Onboarding</div>
          <div className="text-xs text-text-muted">
            Show a welcome wizard to new members when they join
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={onboardingEnabled}
          onClick={() => setOnboardingEnabled(!onboardingEnabled)}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors ${
            onboardingEnabled ? 'bg-accent' : 'bg-bg-surface'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
              onboardingEnabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {/* Welcome Message */}
      <div>
        <label
          htmlFor="welcome-message"
          className="mb-1.5 block text-sm font-medium text-text"
        >
          Welcome Message
        </label>
        <textarea
          id="welcome-message"
          value={welcomeMessage}
          onChange={(e) => setWelcomeMessage(e.target.value)}
          rows={4}
          placeholder="Welcome to our server! We're glad to have you."
          className="w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
        <div
          className={`mt-1 text-xs ${welcomeOverLimit ? 'text-error' : 'text-text-subtle'}`}
        >
          {welcomeMessage.length}/5000
        </div>
      </div>

      {/* Rules */}
      <div>
        <label
          htmlFor="rules"
          className="mb-1.5 block text-sm font-medium text-text"
        >
          Rules
        </label>
        <textarea
          id="rules"
          value={rules}
          onChange={(e) => setRules(e.target.value)}
          rows={6}
          placeholder="One rule per line..."
          className="w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
        <div
          className={`mt-1 text-xs ${rulesOverLimit ? 'text-error' : 'text-text-subtle'}`}
        >
          {rulesLineCount}/25 rules
        </div>
      </div>

      {/* Require acknowledgement */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-text">
            Require Rules Acknowledgement
          </div>
          <div className="text-xs text-text-muted">
            Block messaging until members acknowledge the rules
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={rulesRequired}
          onClick={() => setRulesRequired(!rulesRequired)}
          disabled={!onboardingEnabled}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:opacity-50 ${
            rulesRequired ? 'bg-accent' : 'bg-bg-surface'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
              rulesRequired ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {/* Default Channels */}
      <div>
        <div className="mb-1.5 text-sm font-medium text-text">
          Default Channels
        </div>
        <div className="text-xs text-text-muted mb-2">
          Pre-selected channels in the onboarding wizard
        </div>
        <div className="space-y-1">
          {eligibleChannels.map((ch) => (
            <ChannelToggle
              key={ch.id}
              channel={ch}
              checked={defaultChannelIds.has(ch.id)}
              onChange={(checked) => {
                const next = new Set(defaultChannelIds);
                if (checked) next.add(ch.id);
                else next.delete(ch.id);
                setDefaultChannelIds(next);
              }}
            />
          ))}
          {eligibleChannels.length === 0 && (
            <div className="text-xs text-text-subtle">
              No eligible channels (non-private text channels)
            </div>
          )}
        </div>
      </div>

      {/* Self-Assignable Roles */}
      <div>
        <div className="mb-1.5 text-sm font-medium text-text">
          Self-Assignable Roles
        </div>
        <div className="text-xs text-text-muted mb-2">
          Roles that members can pick during onboarding
        </div>
        <div className="space-y-1">
          {roles.map((r) => (
            <RoleToggle
              key={r.id}
              role={r}
              checked={selfAssignableRoleIds.has(r.id)}
              onChange={(checked) => {
                const next = new Set(selfAssignableRoleIds);
                if (checked) next.add(r.id);
                else next.delete(r.id);
                setSelfAssignableRoleIds(next);
              }}
            />
          ))}
          {roles.length === 0 && (
            <div className="text-xs text-text-subtle">No roles created yet</div>
          )}
        </div>
      </div>

      {/* Error / Success */}
      {error && <p className="text-xs text-error">{error}</p>}
      {success && (
        <p className="text-xs text-accent">Settings saved successfully</p>
      )}

      {/* Save */}
      <button
        type="button"
        onClick={handleSave}
        disabled={saving || welcomeOverLimit || rulesOverLimit}
        className="rounded-md bg-accent px-6 py-2 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-50"
      >
        {saving ? 'Saving...' : 'Save Changes'}
      </button>
    </div>
  );
}

function ChannelToggle({
  channel,
  checked,
  onChange,
}: {
  channel: Channel;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-bg-surface cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-border bg-bg-surface accent-accent"
      />
      <span className="text-text-subtle">#</span>
      <span className="text-sm text-text">{channel.name}</span>
    </label>
  );
}

function RoleToggle({
  role,
  checked,
  onChange,
}: {
  role: Role;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const colorHex = roleColorHex(role.color);

  return (
    <label className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-bg-surface cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-border bg-bg-surface accent-accent"
      />
      {colorHex && (
        <span
          className="h-3 w-3 rounded-full"
          style={{ backgroundColor: colorHex }}
        />
      )}
      <span className="text-sm text-text">{role.name}</span>
    </label>
  );
}
