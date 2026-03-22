import {
  listBlocks,
  unblockUser,
  updateProfile,
  useAuthStore,
  useBlockStore,
} from '@meza/core';
import { useEffect, useState } from 'react';

const DM_PRIVACY_OPTIONS = [
  {
    value: 'anyone',
    label: 'Anyone',
    description: 'Anyone can send you a direct message.',
  },
  {
    value: 'message_requests',
    label: 'Message Requests',
    description:
      'People who share a server with you can DM freely. Others go through message requests.',
  },
  {
    value: 'friends',
    label: 'Friends Only',
    description:
      'Only friends can DM you freely. Others go through message requests.',
  },
  {
    value: 'mutual_servers',
    label: 'Mutual Servers Only',
    description: 'Only people who share a server with you can DM you.',
  },
  {
    value: 'nobody',
    label: 'Nobody',
    description: 'No one can send you new direct messages.',
  },
] as const;

const FRIEND_REQUEST_PRIVACY_OPTIONS = [
  {
    value: 'everyone',
    label: 'Everyone',
    description: 'Anyone can send you a friend request.',
  },
  {
    value: 'server_co_members',
    label: 'Server Members',
    description:
      'Only people who share a server with you can send friend requests.',
  },
  {
    value: 'nobody',
    label: 'Nobody',
    description: 'No one can send you friend requests.',
  },
] as const;

const PROFILE_PRIVACY_OPTIONS = [
  {
    value: 'everyone',
    label: 'Everyone',
    description: 'Anyone can see your full profile.',
  },
  {
    value: 'server_co_members',
    label: 'Server Members',
    description:
      'Only people who share a server with you can see your full profile.',
  },
  {
    value: 'friends',
    label: 'Friends Only',
    description: 'Only friends can see your full profile.',
  },
  {
    value: 'nobody',
    label: 'Nobody',
    description:
      'No one can see your full profile. Others see only your username and avatar.',
  },
] as const;

function PrivacyRadioGroup({
  label,
  name,
  options,
  currentValue,
  saving,
  onChange,
}: {
  label: string;
  name: string;
  options: ReadonlyArray<{ value: string; label: string; description: string }>;
  currentValue: string;
  saving: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-3">
      <span className="block text-sm font-medium text-text">{label}</span>
      <div className="space-y-2">
        {options.map((option) => (
          <label
            key={option.value}
            className={`flex items-start gap-3 rounded-md border px-3 py-2.5 cursor-pointer transition-colors ${
              currentValue === option.value
                ? 'border-accent bg-accent-subtle'
                : 'border-border hover:border-border-hover'
            }`}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={currentValue === option.value}
              disabled={saving}
              onChange={() => onChange(option.value)}
              className="mt-0.5 accent-accent"
            />
            <div>
              <div className="text-sm font-medium text-text">
                {option.label}
              </div>
              <div className="text-xs text-text-muted">
                {option.description}
              </div>
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}

export function PrivacySection() {
  const user = useAuthStore((s) => s.user);
  const blockedUsers = useBlockStore((s) => s.blockedUsers);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  const [unblocking, setUnblocking] = useState<string | null>(null);

  useEffect(() => {
    listBlocks().catch(() => {});
  }, []);

  if (!user) return null;

  const currentPrivacy = user.dmPrivacy || 'message_requests';
  const currentFriendRequestPrivacy = user.friendRequestPrivacy || 'everyone';
  const currentProfilePrivacy = user.profilePrivacy || 'everyone';

  async function handlePrivacyUpdate(field: string, value: string) {
    if (saving) return;
    setSaving(true);
    setFeedback(null);
    try {
      await updateProfile({ [field]: value });
      setFeedback({ type: 'success', message: 'Privacy setting updated.' });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to save.',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleUnblock(userId: string) {
    setUnblocking(userId);
    try {
      await unblockUser(userId);
    } catch {
      setFeedback({ type: 'error', message: 'Failed to unblock user.' });
    } finally {
      setUnblocking(null);
    }
  }

  return (
    <div className="max-w-md space-y-6">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
        Privacy
      </h2>

      <PrivacyRadioGroup
        label="Who can send you direct messages?"
        name="dm-privacy"
        options={DM_PRIVACY_OPTIONS}
        currentValue={currentPrivacy}
        saving={saving}
        onChange={(value) => handlePrivacyUpdate('dmPrivacy', value)}
      />

      <PrivacyRadioGroup
        label="Who can send you friend requests?"
        name="friend-request-privacy"
        options={FRIEND_REQUEST_PRIVACY_OPTIONS}
        currentValue={currentFriendRequestPrivacy}
        saving={saving}
        onChange={(value) => handlePrivacyUpdate('friendRequestPrivacy', value)}
      />

      <PrivacyRadioGroup
        label="Who can see your full profile?"
        name="profile-privacy"
        options={PROFILE_PRIVACY_OPTIONS}
        currentValue={currentProfilePrivacy}
        saving={saving}
        onChange={(value) => handlePrivacyUpdate('profilePrivacy', value)}
      />

      {feedback && (
        <output
          className={`block text-sm ${
            feedback.type === 'success' ? 'text-success' : 'text-error'
          }`}
        >
          {feedback.message}
        </output>
      )}

      {/* Blocked Users */}
      <div className="space-y-3">
        <span className="block text-sm font-medium text-text">
          Blocked Users
        </span>
        {blockedUsers.length === 0 ? (
          <p className="text-xs text-text-subtle">
            You haven't blocked anyone.
          </p>
        ) : (
          <div className="space-y-1">
            {blockedUsers.map((blocked) => (
              <div
                key={blocked.id}
                className="flex items-center justify-between rounded-md border border-border px-3 py-2"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <div className="size-7 rounded-full bg-bg-tertiary flex items-center justify-center text-xs font-semibold text-text-primary shrink-0">
                    {(blocked.displayName ||
                      blocked.username ||
                      '?')[0]?.toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-text truncate">
                      {blocked.displayName || blocked.username}
                    </div>
                    <div className="text-xs text-text-subtle truncate">
                      @{blocked.username}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  className="shrink-0 rounded px-2 py-1 text-xs font-medium text-red-400 hover:bg-red-400/10 transition-colors disabled:opacity-50"
                  disabled={unblocking === blocked.id}
                  onClick={() => handleUnblock(blocked.id)}
                >
                  {unblocking === blocked.id ? 'Unblocking...' : 'Unblock'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
