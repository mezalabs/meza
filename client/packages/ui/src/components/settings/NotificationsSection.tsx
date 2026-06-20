import {
  type BadgeMode,
  type SoundType,
  soundManager,
  useNotificationSettingsStore,
} from '@meza/core';

const SOUND_LABELS: { type: SoundType; label: string }[] = [
  { type: 'message', label: 'Channel messages' },
  { type: 'dm', label: 'Direct messages' },
  { type: 'mention', label: 'Mentions (@you, @everyone)' },
  { type: 'voice-join', label: 'Voice channel joins' },
  { type: 'voice-leave', label: 'Voice channel leaves' },
  { type: 'call-connect', label: 'Call connected' },
  { type: 'call-end', label: 'Call ended' },
  { type: 'stream-start', label: 'Someone starts streaming' },
  { type: 'stream-end', label: 'Stream ended' },
  { type: 'stream-join', label: 'Viewer joined your stream' },
  { type: 'stream-leave', label: 'Viewer left your stream' },
  { type: 'mute', label: 'Mute microphone' },
  { type: 'unmute', label: 'Unmute microphone' },
];

const BADGE_OPTIONS: {
  value: BadgeMode;
  label: string;
  description: string;
}[] = [
  {
    value: 'all',
    label: 'All unreads',
    description: 'Badge shows total unread messages',
  },
  {
    value: 'mentions_dms',
    label: 'Mentions & DMs only',
    description: 'Badge shows only mentions and direct messages',
  },
  { value: 'off', label: 'Off', description: 'No badge count on the app icon' },
];

export function NotificationsSection() {
  const soundEnabled = useNotificationSettingsStore((s) => s.soundEnabled);
  const enabledSounds = useNotificationSettingsStore((s) => s.enabledSounds);
  const notificationVolume = useNotificationSettingsStore(
    (s) => s.notificationVolume,
  );
  const badgeMode = useNotificationSettingsStore((s) => s.badgeMode);

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <h2 className="text-lg font-semibold text-text">Notifications</h2>

      {/* Badge mode */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-text-muted">Badge</h3>
        <p className="text-xs text-text-muted">
          Controls the unread count shown on the app icon in your dock or
          taskbar.
        </p>
        <div className="space-y-2">
          {BADGE_OPTIONS.map(({ value, label, description }) => (
            <label
              key={value}
              className="flex cursor-pointer items-start gap-3 rounded-md px-2 py-1.5 hover:bg-bg-surface transition-colors"
            >
              <input
                type="radio"
                name="badge-mode"
                value={value}
                checked={badgeMode === value}
                onChange={() =>
                  useNotificationSettingsStore.getState().setBadgeMode(value)
                }
                className="mt-0.5 accent-accent"
              />
              <div>
                <span className="text-sm text-text">{label}</span>
                <p className="text-xs text-text-muted">{description}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Master toggle */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-text-muted">Sounds</h3>
        <ToggleSwitch
          id="notification-master"
          label="Enable notification sounds"
          checked={soundEnabled}
          onToggle={() =>
            useNotificationSettingsStore
              .getState()
              .setSoundEnabled(!soundEnabled)
          }
        />
      </div>

      {/* Volume slider */}
      {soundEnabled && (
        <>
          <div className="space-y-2">
            <label
              htmlFor="notification-volume"
              className="text-sm text-text-muted"
            >
              Notification Volume — {Math.round(notificationVolume * 100)}%
            </label>
            <input
              id="notification-volume"
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(notificationVolume * 100)}
              onChange={(e) =>
                useNotificationSettingsStore
                  .getState()
                  .setNotificationVolume(Number(e.target.value) / 100)
              }
              className="w-full accent-accent"
            />
          </div>

          {/* Per-sound toggles */}
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-text-muted">Sound Types</h3>
            {SOUND_LABELS.map(({ type, label }) => (
              <div key={type} className="flex items-center justify-between">
                <ToggleSwitch
                  id={`notification-${type}`}
                  label={label}
                  checked={enabledSounds[type]}
                  onToggle={() =>
                    useNotificationSettingsStore
                      .getState()
                      .setEnabledSound(type, !enabledSounds[type])
                  }
                />
                <button
                  type="button"
                  onClick={() => soundManager.preview(type)}
                  className="shrink-0 rounded px-2 py-1 text-xs text-text-muted hover:bg-bg-surface hover:text-text transition-colors"
                  aria-label={`Preview ${label} sound`}
                >
                  Preview
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ToggleSwitch({
  id,
  label,
  checked,
  onToggle,
}: {
  id: string;
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={onToggle}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
          checked ? 'bg-accent' : 'bg-bg-surface'
        }`}
      >
        <span
          className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-0.5'
          } mt-0.5`}
        />
      </button>
      <label htmlFor={id} className="text-sm text-text-muted cursor-pointer">
        {label}
      </label>
    </div>
  );
}
