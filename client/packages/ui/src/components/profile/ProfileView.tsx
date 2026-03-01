import {
  acceptFriendRequest,
  blockUser,
  cancelFriendRequest,
  declineFriendRequest,
  type FriendRequestEntry,
  getMediaURL,
  getPresence,
  getProfile,
  removeFriend,
  type StoredUser,
  sendFriendRequest,
  UploadPurpose,
  type User,
  unblockUser,
  updateProfile,
  uploadFile,
  useAuthStore,
  useBlockStore,
  useFriendStore,
  useUsersStore,
} from '@meza/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar } from '../shared/Avatar.tsx';
import { MarkdownRenderer } from '../shared/MarkdownRenderer.tsx';
import { PresenceDot } from '../shared/PresenceDot.tsx';

interface ProfileViewProps {
  userId: string;
}

type ViewState = 'loading' | 'error' | 'not-found' | 'ready';

export function ProfileView({ userId }: ProfileViewProps) {
  const currentUser = useAuthStore((s) => s.user);
  const cachedProfile = useUsersStore((s) => s.profiles[userId]);
  const [profile, setProfile] = useState<StoredUser | null>(
    cachedProfile ?? null,
  );
  const [viewState, setViewState] = useState<ViewState>(
    cachedProfile ? 'ready' : 'loading',
  );
  const [isEditing, setIsEditing] = useState(false);

  const isOwnProfile = currentUser?.id === userId;
  const isBlocked = useBlockStore((s) => s.isBlocked(userId));
  const [blockLoading, setBlockLoading] = useState(false);
  const friendRelationship = useFriendStore((s) => s.getRelationship(userId));
  const [friendLoading, setFriendLoading] = useState(false);

  const fetchProfile = useCallback(async () => {
    setViewState('loading');
    try {
      const p = await getProfile(userId);
      setProfile(p);
      setViewState('ready');
    } catch (err) {
      if (err instanceof Error && err.message === 'User not found') {
        setViewState('not-found');
      } else {
        setViewState('error');
      }
    }
  }, [userId]);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  // Fetch presence for this user
  useEffect(() => {
    getPresence(userId).catch(() => {});
  }, [userId]);

  if (viewState === 'loading') {
    return <ProfileSkeleton />;
  }

  if (viewState === 'not-found') {
    return (
      <div className="flex flex-1 min-h-0 min-w-0 flex-col items-center justify-center text-sm text-text-muted">
        User not found
      </div>
    );
  }

  if (viewState === 'error') {
    return (
      <div className="flex flex-1 min-h-0 min-w-0 flex-col items-center justify-center gap-2 text-sm text-text-muted">
        <span>Could not load profile</span>
        <button
          type="button"
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-black hover:bg-accent-hover"
          onClick={fetchProfile}
        >
          Retry
        </button>
      </div>
    );
  }

  if (!profile) return null;

  if (isEditing && isOwnProfile) {
    return (
      <ProfileEditMode
        profile={profile}
        onSave={(updated) => {
          setProfile(updated);
          setIsEditing(false);
        }}
        onCancel={() => setIsEditing(false)}
      />
    );
  }

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col">
      <div className="flex-1 overflow-y-auto">
        {/* Banner */}
        <ProfileBanner profile={profile} />

        {/* Avatar + name area */}
        <div className="px-4 -mt-8">
          <div className="relative inline-block">
            <Avatar
              avatarUrl={profile.avatarUrl}
              displayName={profile.displayName || profile.username}
              size="xl"
              className="ring-4 ring-bg-overlay"
            />
            <PresenceDot
              userId={userId}
              size="md"
              className="absolute -bottom-1 -right-1 ring-3 ring-bg-overlay"
            />
          </div>
        </div>

        <div className="px-4 pt-3 space-y-3">
          {/* Display name + pronouns */}
          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-semibold text-text">
                {profile.displayName || profile.username}
              </span>
              {profile.pronouns && (
                <span className="text-sm text-text-muted">
                  {profile.pronouns}
                </span>
              )}
            </div>
            <div className="text-sm text-text-subtle">@{profile.username}</div>
          </div>

          {/* Bio */}
          {profile.bio && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-text-subtle mb-1">
                About
              </h3>
              <MarkdownRenderer content={profile.bio} variant="full" />
            </div>
          )}

          {/* Edit button */}
          {isOwnProfile && (
            <button
              type="button"
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent-hover"
              onClick={() => setIsEditing(true)}
            >
              Edit Profile
            </button>
          )}

          {/* Friend + Block actions */}
          {!isOwnProfile && (
            <div className="flex items-center gap-2">
              {!isBlocked && (
                <FriendButton
                  relationship={friendRelationship}
                  loading={friendLoading}
                  onAction={async (action) => {
                    setFriendLoading(true);
                    try {
                      switch (action) {
                        case 'add': {
                          const res = await sendFriendRequest(userId);
                          if (res.autoAccepted) {
                            if (profile)
                              useFriendStore
                                .getState()
                                .acceptFriend(profile as unknown as User);
                          } else {
                            useFriendStore.getState().addOutgoingRequest({
                              user: profile as unknown as User,
                              direction: 'outgoing',
                              createdAt: new Date().toISOString(),
                            } as FriendRequestEntry);
                          }
                          break;
                        }
                        case 'cancel':
                          await cancelFriendRequest(userId);
                          useFriendStore
                            .getState()
                            .removeOutgoingRequest(userId);
                          break;
                        case 'accept':
                          await acceptFriendRequest(userId);
                          if (profile)
                            useFriendStore
                              .getState()
                              .acceptFriend(profile as unknown as User);
                          break;
                        case 'decline':
                          await declineFriendRequest(userId);
                          useFriendStore
                            .getState()
                            .removeIncomingRequest(userId);
                          break;
                        case 'remove':
                          await removeFriend(userId);
                          useFriendStore.getState().removeFriend(userId);
                          break;
                      }
                    } finally {
                      setFriendLoading(false);
                    }
                  }}
                />
              )}
              <button
                type="button"
                className={`rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
                  isBlocked
                    ? 'bg-bg-surface text-text-muted hover:text-text'
                    : 'bg-red-600 text-white hover:bg-red-500'
                }`}
                disabled={blockLoading}
                onClick={async () => {
                  setBlockLoading(true);
                  try {
                    if (isBlocked) {
                      await unblockUser(userId);
                    } else {
                      await blockUser(userId);
                    }
                  } finally {
                    setBlockLoading(false);
                  }
                }}
              >
                {blockLoading
                  ? isBlocked
                    ? 'Unblocking...'
                    : 'Blocking...'
                  : isBlocked
                    ? 'Unblock'
                    : 'Block'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type FriendAction = 'add' | 'cancel' | 'accept' | 'decline' | 'remove';

function FriendButton({
  relationship,
  loading,
  onAction,
}: {
  relationship: 'friends' | 'incoming' | 'outgoing' | 'none';
  loading: boolean;
  onAction: (action: FriendAction) => Promise<void>;
}) {
  switch (relationship) {
    case 'none':
      return (
        <button
          type="button"
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-50"
          disabled={loading}
          onClick={() => onAction('add')}
        >
          {loading ? 'Sending...' : 'Add Friend'}
        </button>
      );
    case 'outgoing':
      return (
        <button
          type="button"
          className="rounded-md bg-bg-surface px-4 py-2 text-sm font-medium text-text-muted hover:text-text disabled:opacity-50"
          disabled={loading}
          onClick={() => onAction('cancel')}
        >
          {loading ? 'Cancelling...' : 'Request Sent'}
        </button>
      );
    case 'incoming':
      return (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="rounded-md bg-success px-4 py-2 text-sm font-medium text-black hover:bg-success/80 disabled:opacity-50"
            disabled={loading}
            onClick={() => onAction('accept')}
          >
            {loading ? 'Accepting...' : 'Accept'}
          </button>
          <button
            type="button"
            className="rounded-md bg-bg-surface px-4 py-2 text-sm font-medium text-text-muted hover:text-text disabled:opacity-50"
            disabled={loading}
            onClick={() => onAction('decline')}
          >
            Decline
          </button>
        </div>
      );
    case 'friends':
      return (
        <button
          type="button"
          className="rounded-md bg-bg-surface px-4 py-2 text-sm font-medium text-text-muted hover:text-red-400 hover:bg-red-500/10 disabled:opacity-50 transition-colors"
          disabled={loading}
          onClick={() => onAction('remove')}
        >
          {loading ? 'Removing...' : 'Friends'}
        </button>
      );
  }
}

function ProfileBanner({ profile }: { profile: StoredUser }) {
  const hasBanner = !!profile.bannerUrl;
  const hasThemeColors = !!profile.themeColorPrimary;

  if (hasBanner) {
    const match = profile.bannerUrl.match(/^\/media\/([^/?]+)/);
    const src = match ? getMediaURL(match[1], false) : profile.bannerUrl;
    return (
      <div className="h-[120px] w-full overflow-hidden">
        <img src={src} alt="" className="h-full w-full object-cover" />
      </div>
    );
  }

  if (hasThemeColors) {
    return (
      <div
        className="h-[120px] w-full"
        style={{
          background: `linear-gradient(135deg, #${profile.themeColorPrimary}, #${profile.themeColorSecondary || profile.themeColorPrimary})`,
        }}
      />
    );
  }

  return <div className="h-[120px] w-full bg-bg-surface" />;
}

function ProfileSkeleton() {
  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col animate-pulse">
      <div className="h-[120px] w-full bg-bg-surface" />
      <div className="px-4 -mt-8">
        <div className="h-16 w-16 rounded-full bg-bg-elevated ring-4 ring-bg-overlay" />
      </div>
      <div className="px-4 pt-3 space-y-3">
        <div className="h-5 w-32 rounded bg-bg-surface" />
        <div className="h-4 w-24 rounded bg-bg-surface" />
        <div className="h-12 w-full rounded bg-bg-surface" />
      </div>
    </div>
  );
}

function ProfileEditMode({
  profile,
  onSave,
  onCancel,
}: {
  profile: StoredUser;
  onSave: (updated: StoredUser) => void;
  onCancel: () => void;
}) {
  const [displayName, setDisplayName] = useState(profile.displayName || '');
  const [bio, setBio] = useState(profile.bio || '');
  const [pronouns, setPronouns] = useState(profile.pronouns || '');
  const [themeColorPrimary, setThemeColorPrimary] = useState(
    profile.themeColorPrimary || '',
  );
  const [themeColorSecondary, setThemeColorSecondary] = useState(
    profile.themeColorSecondary || '',
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);

  const avatarInputRef = useRef<HTMLInputElement>(null);
  const bannerInputRef = useRef<HTMLInputElement>(null);

  const isDirty =
    displayName.trim() !== (profile.displayName || '') ||
    bio.trim() !== (profile.bio || '') ||
    pronouns.trim() !== (profile.pronouns || '') ||
    themeColorPrimary !== (profile.themeColorPrimary || '') ||
    themeColorSecondary !== (profile.themeColorSecondary || '');

  async function handleAvatarUpload(file: File) {
    setUploadProgress(0);
    setError('');
    try {
      const result = await uploadFile(
        file,
        UploadPurpose.PROFILE_AVATAR,
        setUploadProgress,
      );
      await updateProfile({ avatarUrl: `/media/${result.attachmentId}` });
      // Refresh profile
      const updated = await getProfile(profile.id);
      onSave(updated);
    } catch {
      setError('Failed to upload avatar');
    } finally {
      setUploadProgress(null);
    }
  }

  async function handleBannerUpload(file: File) {
    setUploadProgress(0);
    setError('');
    try {
      const result = await uploadFile(
        file,
        UploadPurpose.PROFILE_BANNER,
        setUploadProgress,
      );
      await updateProfile({ bannerUrl: `/media/${result.attachmentId}` });
      const updated = await getProfile(profile.id);
      onSave(updated);
    } catch {
      setError('Failed to upload banner');
    } finally {
      setUploadProgress(null);
    }
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const params: Record<string, string | undefined> = {};
      if (displayName.trim() !== (profile.displayName || '')) {
        params.displayName = displayName.trim();
      }
      if (bio.trim() !== (profile.bio || '')) {
        params.bio = bio.trim();
      }
      if (pronouns.trim() !== (profile.pronouns || '')) {
        params.pronouns = pronouns.trim();
      }
      if (themeColorPrimary !== (profile.themeColorPrimary || '')) {
        params.themeColorPrimary = themeColorPrimary;
      }
      if (themeColorSecondary !== (profile.themeColorSecondary || '')) {
        params.themeColorSecondary = themeColorSecondary;
      }
      await updateProfile(params);
      const updated = await getProfile(profile.id);
      onSave(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col">
      <div className="flex-1 overflow-y-auto">
        {/* Banner (click to upload) */}
        <button
          type="button"
          className="relative h-[120px] w-full overflow-hidden cursor-pointer group"
          onClick={() => bannerInputRef.current?.click()}
        >
          <ProfileBanner profile={profile} />
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity">
            <span className="text-sm font-medium text-white">
              Change Banner
            </span>
          </div>
        </button>
        <input
          ref={bannerInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleBannerUpload(file);
          }}
        />

        {/* Avatar (click to upload) */}
        <div className="px-4 -mt-8">
          <button
            type="button"
            className="relative inline-block cursor-pointer group"
            onClick={() => avatarInputRef.current?.click()}
          >
            <Avatar
              avatarUrl={profile.avatarUrl}
              displayName={profile.displayName || profile.username}
              size="xl"
              className="ring-4 ring-bg-overlay"
            />
            <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity">
              <span className="text-xs font-medium text-white">Change</span>
            </div>
          </button>
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleAvatarUpload(file);
            }}
          />
        </div>

        {/* Upload progress */}
        {uploadProgress !== null && (
          <div className="px-4 pt-2">
            <div className="h-1.5 w-full rounded-full bg-bg-surface">
              <div
                className="h-full rounded-full bg-accent transition-all"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          </div>
        )}

        <div className="px-4 pt-3 space-y-4">
          {/* Display name */}
          <div className="space-y-1">
            <label
              htmlFor="profile-display-name"
              className="block text-sm font-medium text-text"
            >
              Display Name
            </label>
            <input
              id="profile-display-name"
              type="text"
              className="w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={32}
            />
            <p className="text-xs text-text-subtle">
              {displayName.trim().length}/32
            </p>
          </div>

          {/* Pronouns */}
          <div className="space-y-1">
            <label
              htmlFor="profile-pronouns"
              className="block text-sm font-medium text-text"
            >
              Pronouns
            </label>
            <input
              id="profile-pronouns"
              type="text"
              className="w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
              value={pronouns}
              onChange={(e) => setPronouns(e.target.value)}
              maxLength={50}
              placeholder="e.g. they/them"
            />
          </div>

          {/* Bio */}
          <div className="space-y-1">
            <label
              htmlFor="profile-bio"
              className="block text-sm font-medium text-text"
            >
              Bio
            </label>
            <textarea
              id="profile-bio"
              className="w-full resize-none rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              maxLength={1000}
              rows={4}
              placeholder="Tell us about yourself"
            />
            <p className="text-xs text-text-subtle">{bio.trim().length}/1000</p>
          </div>

          {/* Theme colors */}
          <div className="space-y-1">
            <span className="block text-sm font-medium text-text">
              Theme Colors
            </span>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-text-muted">
                Primary
                <input
                  type="color"
                  value={
                    themeColorPrimary ? `#${themeColorPrimary}` : '#6366f1'
                  }
                  onChange={(e) =>
                    setThemeColorPrimary(e.target.value.replace('#', ''))
                  }
                  className="h-8 w-8 cursor-pointer rounded border border-border"
                />
              </label>
              <label className="flex items-center gap-2 text-sm text-text-muted">
                Secondary
                <input
                  type="color"
                  value={
                    themeColorSecondary ? `#${themeColorSecondary}` : '#8b5cf6'
                  }
                  onChange={(e) =>
                    setThemeColorSecondary(e.target.value.replace('#', ''))
                  }
                  className="h-8 w-8 cursor-pointer rounded border border-border"
                />
              </label>
            </div>
          </div>

          {/* Error */}
          {error && <p className="text-sm text-error">{error}</p>}

          {/* Actions */}
          <div className="flex items-center gap-3 pb-4">
            <button
              type="button"
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-50"
              disabled={!isDirty || saving}
              onClick={handleSave}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              type="button"
              className="rounded-md bg-bg-surface px-4 py-2 text-sm text-text-muted hover:text-text"
              onClick={onCancel}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
