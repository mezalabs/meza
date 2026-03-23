import {
  acceptBotInvite,
  removeBotFromServer,
  useMemberStore,
  useUsersStore,
} from '@meza/core';
import { CaretRightIcon, RobotIcon } from '@phosphor-icons/react';
import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { Avatar } from '../shared/Avatar.tsx';
import { IncomingWebhookManagement } from './IncomingWebhookManagement.tsx';
import { OutgoingWebhookManagement } from './OutgoingWebhookManagement.tsx';

const EMPTY_MEMBERS: never[] = [];

interface ServerBotsSectionProps {
  serverId: string;
}

export function ServerBotsSection({ serverId }: ServerBotsSectionProps) {
  const members = useMemberStore((s) => s.byServer[serverId] ?? EMPTY_MEMBERS);
  const profiles = useUsersStore((s) => s.profiles);

  // Filter members whose user profile is marked as a bot
  const botMembers = members.filter((m) => profiles[m.userId]?.isBot);

  const [inviteCode, setInviteCode] = useState('');
  const [inviteError, setInviteError] = useState('');
  const [isInviting, setIsInviting] = useState(false);
  const [expandedBotId, setExpandedBotId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<{
    userId: string;
    displayName: string;
  } | null>(null);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);

  /**
   * Extract the invite code from user input.
   * Accepts a bare code or a full URL like https://meza.app/bot-invite/CODE
   */
  function extractInviteCode(input: string): string {
    const trimmed = input.trim();
    // Try to extract code from a URL
    const urlMatch = trimmed.match(/bot-invite\/([A-Za-z0-9_-]+)/);
    if (urlMatch) return urlMatch[1];
    // Otherwise treat the whole input as a code
    return trimmed;
  }

  async function handleAcceptInvite() {
    const code = extractInviteCode(inviteCode);
    if (!code) return;

    setInviteError('');
    setIsInviting(true);
    try {
      await acceptBotInvite(code, serverId);
      setInviteCode('');
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : 'Failed to add bot');
    } finally {
      setIsInviting(false);
    }
  }

  function openRemoveDialog(userId: string) {
    const profile = profiles[userId];
    const displayName =
      profile?.displayName || profile?.username || userId.slice(0, 8);
    setRemoveTarget({ userId, displayName });
    setRemoveDialogOpen(true);
  }

  return (
    <div>
      <h2 className="mb-4 text-lg font-semibold text-text">Bots</h2>

      {/* Paste Invite Link */}
      <div className="mb-6 rounded-lg border border-border bg-bg-surface p-4">
        <h3 className="mb-2 text-sm font-medium text-text">Add a Bot</h3>
        <p className="mb-3 text-xs text-text-muted">
          Paste a bot invite link or code to add a bot to this server.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAcceptInvite();
            }}
            placeholder="Paste invite link or code"
            disabled={isInviting}
            className="flex-1 rounded-md border border-border bg-bg-surface px-3 py-1.5 text-sm text-text placeholder:text-text-subtle focus:border-accent focus:outline-none disabled:opacity-50"
          />
          <button
            type="button"
            onClick={handleAcceptInvite}
            disabled={isInviting || !inviteCode.trim()}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-black hover:bg-accent/80 disabled:opacity-50"
          >
            {isInviting ? 'Adding...' : 'Add Bot'}
          </button>
        </div>
        {inviteError && (
          <p className="mt-2 text-xs text-error">{inviteError}</p>
        )}
      </div>

      {/* Empty state */}
      {botMembers.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border/40 bg-bg-surface/50 py-10">
          <RobotIcon size={40} className="text-text-muted" aria-hidden="true" />
          <div className="text-center">
            <p className="text-sm font-medium text-text">
              No bots in this server
            </p>
            <p className="mt-1 text-xs text-text-muted">
              Add one with a bot invite link above.
            </p>
          </div>
        </div>
      )}

      {/* Bot list */}
      {botMembers.length > 0 && (
        <div className="flex flex-col gap-2">
          {botMembers.map((member) => {
            const profile = profiles[member.userId];
            const displayName =
              profile?.displayName ||
              profile?.username ||
              member.userId.slice(0, 8);
            const joinedDate = member.joinedAt
              ? new Date(
                  Number(member.joinedAt.seconds) * 1000,
                ).toLocaleDateString(undefined, {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })
              : 'Unknown';
            const isExpanded = expandedBotId === member.userId;

            return (
              <div
                key={member.userId}
                className="rounded-lg border border-border bg-bg-surface"
              >
                <div className="flex items-center gap-3 p-3">
                  <Avatar
                    avatarUrl={profile?.avatarUrl}
                    displayName={displayName}
                    size="lg"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-text">
                        {displayName}
                      </span>
                      <RobotIcon
                        size={12}
                        className="flex-shrink-0 text-text-muted"
                        aria-hidden="true"
                      />
                    </div>
                    {profile?.username && (
                      <span className="block truncate text-xs text-text-muted">
                        @{profile.username}
                      </span>
                    )}
                    {profile?.bio && (
                      <span className="mt-0.5 block truncate text-xs text-text-muted">
                        {profile.bio}
                      </span>
                    )}
                    <span className="mt-0.5 block text-[10px] text-text-subtle">
                      Joined {joinedDate}
                    </span>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedBotId(isExpanded ? null : member.userId)
                      }
                      className="rounded-md px-2 py-1 text-xs text-text-muted hover:bg-bg-elevated hover:text-text transition-colors"
                      title="Manage Webhooks"
                    >
                      <span className="flex items-center gap-1">
                        Webhooks
                        <CaretRightIcon
                          size={12}
                          className={`transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                          aria-hidden="true"
                        />
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => openRemoveDialog(member.userId)}
                      className="rounded-md px-2 py-1 text-xs text-error hover:bg-error/10 transition-colors"
                    >
                      Remove
                    </button>
                  </div>
                </div>

                {/* Webhook management expandable area */}
                {isExpanded && (
                  <div className="border-t border-border px-3 py-3">
                    <WebhookManagement
                      serverId={serverId}
                      botUserId={member.userId}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Remove Bot Dialog */}
      {removeTarget && (
        <RemoveBotDialog
          serverId={serverId}
          botUserId={removeTarget.userId}
          displayName={removeTarget.displayName}
          open={removeDialogOpen}
          onOpenChange={(open) => {
            setRemoveDialogOpen(open);
            if (!open) setRemoveTarget(null);
          }}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Webhook Management (combined outgoing + incoming per bot)
 * --------------------------------------------------------------------------- */

function WebhookManagement({
  serverId,
  botUserId,
}: {
  serverId: string;
  botUserId: string;
}) {
  const [tab, setTab] = useState<'outgoing' | 'incoming'>('outgoing');

  return (
    <div>
      <div className="mb-3 flex gap-1">
        <button
          type="button"
          onClick={() => setTab('outgoing')}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            tab === 'outgoing'
              ? 'bg-accent-subtle text-text'
              : 'text-text-muted hover:bg-bg-elevated hover:text-text'
          }`}
        >
          Outgoing
        </button>
        <button
          type="button"
          onClick={() => setTab('incoming')}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            tab === 'incoming'
              ? 'bg-accent-subtle text-text'
              : 'text-text-muted hover:bg-bg-elevated hover:text-text'
          }`}
        >
          Incoming
        </button>
      </div>
      {tab === 'outgoing' ? (
        <OutgoingWebhookManagement serverId={serverId} botUserId={botUserId} />
      ) : (
        <IncomingWebhookManagement serverId={serverId} botUserId={botUserId} />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Remove Bot Dialog (follows KickMemberDialog pattern)
 * --------------------------------------------------------------------------- */

interface RemoveBotDialogProps {
  serverId: string;
  botUserId: string;
  displayName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function RemoveBotDialog({
  serverId,
  botUserId,
  displayName,
  open,
  onOpenChange,
}: RemoveBotDialogProps) {
  const [submitError, setSubmitError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const guardedOpenChange = (next: boolean) => {
    if (!next && isSubmitting) return;
    onOpenChange(next);
  };

  async function handleRemove() {
    setSubmitError('');
    setIsSubmitting(true);

    try {
      await removeBotFromServer(botUserId, serverId);
      useMemberStore.getState().removeMember(serverId, botUserId);
      onOpenChange(false);
    } catch {
      setSubmitError('Failed to remove bot');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={guardedOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl bg-bg-elevated p-6 shadow-lg animate-scale-in"
          onEscapeKeyDown={(e) => {
            if (isSubmitting) e.preventDefault();
          }}
        >
          <Dialog.Title className="text-lg font-semibold text-text">
            Remove Bot
          </Dialog.Title>

          <p className="mt-3 text-sm text-text-muted">
            Are you sure you want to remove{' '}
            <strong className="text-text">{displayName}</strong> from this
            server? The bot will need to be re-invited to rejoin.
          </p>

          {submitError && (
            <p className="mt-3 text-xs text-error">{submitError}</p>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button
                type="button"
                disabled={isSubmitting}
                className="rounded-md bg-bg-surface px-3 py-1.5 text-sm text-text-muted hover:bg-bg-elevated hover:text-text disabled:opacity-50"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              disabled={isSubmitting}
              onClick={handleRemove}
              className="rounded-md bg-error px-4 py-2 text-sm font-medium text-white hover:bg-error/80 disabled:opacity-50"
            >
              {isSubmitting ? 'Removing...' : 'Remove Bot'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
