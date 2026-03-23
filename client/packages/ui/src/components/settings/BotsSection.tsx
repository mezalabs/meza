import type { Bot } from '@meza/core';
import { useBotStore } from '@meza/core';
import {
  ArrowsClockwiseIcon,
  CodeIcon,
  LinkSimpleIcon,
  PencilSimpleIcon,
  PlusIcon,
  RobotIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { Avatar } from '../shared/Avatar.tsx';
import { BotInviteDialog } from './BotInviteDialog.tsx';
import { BotTokenModal } from './BotTokenModal.tsx';
import { CreateBotDialog } from './CreateBotDialog.tsx';
import { EditBotDialog } from './EditBotDialog.tsx';

const MAX_BOTS = 25;

export function BotsSection() {
  const bots = useBotStore((s) => s.bots);
  const loading = useBotStore((s) => s.loading);
  const error = useBotStore((s) => s.error);
  const fetchBots = useBotStore((s) => s.fetchBots);
  const deleteBot = useBotStore((s) => s.deleteBot);
  const regenerateToken = useBotStore((s) => s.regenerateToken);

  const [createOpen, setCreateOpen] = useState(false);
  const [editBot, setEditBot] = useState<Bot | null>(null);
  const [inviteBot, setInviteBot] = useState<Bot | null>(null);
  const [tokenData, setTokenData] = useState<{
    token: string;
    privateKey?: Uint8Array;
    botName: string;
  } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    fetchBots();
  }, [fetchBots]);

  const handleRegenerate = async (bot: Bot) => {
    setActionLoading(bot.id);
    try {
      const result = await regenerateToken(bot.id);
      if (result) {
        setTokenData({
          token: result.token,
          botName: bot.displayName || bot.username,
        });
      }
    } catch {
      // error is set in store
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (botId: string) => {
    setActionLoading(botId);
    setConfirmDelete(null);
    try {
      await deleteBot(botId);
    } catch {
      // error is set in store
    } finally {
      setActionLoading(null);
    }
  };

  const formatDate = (timestamp?: { seconds: bigint }) => {
    if (!timestamp) return 'Unknown';
    return new Date(Number(timestamp.seconds) * 1000).toLocaleDateString(
      undefined,
      { year: 'numeric', month: 'short', day: 'numeric' },
    );
  };

  return (
    <div className="max-w-2xl space-y-6">
      {/* Header */}
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text">My Bots</h2>
          <p className="mt-0.5 text-xs text-text-muted">
            Create and manage bots that connect to your servers via the API.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          disabled={bots.length >= MAX_BOTS}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-black shadow-sm transition-all hover:bg-accent-hover hover:shadow-md active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none"
        >
          <PlusIcon size={15} weight="bold" aria-hidden="true" />
          Create Bot
        </button>
      </div>

      {/* Usage indicator */}
      {bots.length > 0 && (
        <div className="flex items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-surface">
            <div
              className="h-full rounded-full bg-accent/60 transition-all duration-500"
              style={{ width: `${(bots.length / MAX_BOTS) * 100}%` }}
            />
          </div>
          <span className="flex-shrink-0 text-xs tabular-nums text-text-subtle">
            {bots.length}/{MAX_BOTS}
          </span>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-error/20 bg-error/5 px-3 py-2.5">
          <div className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-error" />
          <p className="text-xs text-error">{error}</p>
        </div>
      )}

      {/* Loading skeletons */}
      {loading && bots.length === 0 && (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div
              key={i}
              className="animate-pulse rounded-xl border border-border/30 bg-bg-surface/30 p-4"
            >
              <div className="flex items-start gap-4">
                <div className="h-10 w-10 rounded-full bg-bg-elevated/60" />
                <div className="flex-1 space-y-2.5">
                  <div className="h-4 w-32 rounded-md bg-bg-elevated/60" />
                  <div className="h-3 w-20 rounded bg-bg-elevated/40" />
                  <div className="h-3 w-48 rounded bg-bg-elevated/30" />
                </div>
                <div className="flex gap-1">
                  {[1, 2, 3].map((j) => (
                    <div
                      key={j}
                      className="h-7 w-7 rounded-md bg-bg-elevated/40"
                    />
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && bots.length === 0 && (
        <div className="relative overflow-hidden rounded-xl border border-border/30 bg-bg-surface/30">
          {/* Subtle grid pattern background */}
          <div
            className="pointer-events-none absolute inset-0 opacity-[0.03]"
            style={{
              backgroundImage:
                'linear-gradient(rgba(106,255,176,1) 1px, transparent 1px), linear-gradient(90deg, rgba(106,255,176,1) 1px, transparent 1px)',
              backgroundSize: '24px 24px',
            }}
          />
          <div className="relative flex flex-col items-center gap-4 px-6 py-14">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-accent/20 bg-accent/5">
              <RobotIcon
                size={28}
                className="text-accent/70"
                aria-hidden="true"
              />
            </div>
            <div className="max-w-xs text-center">
              <p className="text-sm font-medium text-text">
                Build your first bot
              </p>
              <p className="mt-1.5 text-xs leading-relaxed text-text-muted">
                Bots can send messages, respond to events, and integrate with
                external services like CI/CD pipelines, monitoring tools, and
                no-code platforms.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="mt-1 flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black shadow-sm transition-all hover:bg-accent-hover hover:shadow-md active:scale-[0.98]"
            >
              <PlusIcon size={15} weight="bold" aria-hidden="true" />
              Create Bot
            </button>
          </div>
        </div>
      )}

      {/* Bot cards */}
      {bots.length > 0 && (
        <div className="space-y-3">
          {bots.map((bot) => (
            <div
              key={bot.id}
              className="group relative overflow-hidden rounded-xl border border-border/30 bg-bg-surface/30 transition-all duration-150 hover:border-border/60 hover:bg-bg-surface/60"
            >
              {/* Left accent edge */}
              <div className="absolute left-0 top-0 bottom-0 w-1 rounded-l-xl bg-accent/40 transition-colors group-hover:bg-accent/70" />

              <div className="flex items-start gap-4 p-4 pl-5">
                {/* Avatar */}
                <div className="relative flex-shrink-0 pt-0.5">
                  <Avatar
                    avatarUrl={bot.avatarUrl}
                    displayName={bot.displayName || bot.username}
                    size="lg"
                  />
                  <div className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full border-2 border-bg-base bg-accent-subtle">
                    <CodeIcon
                      size={8}
                      weight="bold"
                      className="text-accent"
                      aria-hidden="true"
                    />
                  </div>
                </div>

                {/* Info */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-text">
                      {bot.displayName || bot.username}
                    </span>
                    <span className="inline-flex items-center rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                      BOT
                    </span>
                  </div>
                  <span className="mt-0.5 block truncate font-mono text-xs text-text-muted">
                    @{bot.username}
                  </span>
                  {bot.description && (
                    <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-text-muted">
                      {bot.description}
                    </p>
                  )}
                  <span className="mt-2 inline-block text-[11px] text-text-subtle">
                    Created {formatDate(bot.createdAt)}
                  </span>
                </div>

                {/* Actions — visible on hover or when loading */}
                <div className="flex flex-shrink-0 items-center gap-1 pt-0.5">
                  {actionLoading === bot.id ? (
                    <div className="flex h-8 w-8 items-center justify-center">
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-text-muted border-t-transparent" />
                    </div>
                  ) : (
                    <>
                      <ActionButton
                        icon={PencilSimpleIcon}
                        label="Edit"
                        onClick={() => setEditBot(bot)}
                      />
                      <ActionButton
                        icon={ArrowsClockwiseIcon}
                        label="Regenerate token"
                        onClick={() => handleRegenerate(bot)}
                      />
                      <ActionButton
                        icon={LinkSimpleIcon}
                        label="Invite link"
                        onClick={() => setInviteBot(bot)}
                      />
                      <ActionButton
                        icon={TrashIcon}
                        label="Delete"
                        variant="danger"
                        onClick={() => setConfirmDelete(bot.id)}
                      />
                    </>
                  )}
                </div>
              </div>

              {/* Delete confirmation overlay */}
              {confirmDelete === bot.id && (
                <div className="absolute inset-0 z-30 flex items-center justify-center rounded-xl bg-bg-base/90 backdrop-blur-sm">
                  <div className="text-center">
                    <p className="text-sm font-medium text-text">
                      Delete {bot.displayName || bot.username}?
                    </p>
                    <p className="mt-1 text-xs text-text-muted">
                      This will remove the bot and revoke all tokens.
                    </p>
                    <div className="mt-3 flex justify-center gap-2">
                      <button
                        type="button"
                        className="rounded-lg border border-border px-3.5 py-1.5 text-xs font-medium text-text-muted transition-colors hover:border-border-hover hover:text-text"
                        onClick={() => setConfirmDelete(null)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="rounded-lg bg-error px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-error/80"
                        onClick={() => handleDelete(bot.id)}
                      >
                        Delete Bot
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Dialogs */}
      <CreateBotDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(data) => {
          setTokenData(data);
          setCreateOpen(false);
        }}
      />

      {editBot && (
        <EditBotDialog
          open={!!editBot}
          onOpenChange={(open) => {
            if (!open) setEditBot(null);
          }}
          bot={editBot}
        />
      )}

      {inviteBot && (
        <BotInviteDialog
          open={!!inviteBot}
          onOpenChange={(open) => {
            if (!open) setInviteBot(null);
          }}
          bot={inviteBot}
        />
      )}

      {tokenData && (
        <BotTokenModal
          open={!!tokenData}
          onOpenChange={(open) => {
            if (!open) setTokenData(null);
          }}
          token={tokenData.token}
          privateKey={tokenData.privateKey}
          botName={tokenData.botName}
        />
      )}
    </div>
  );
}

/* ── Inline action button ── */

function ActionButton({
  icon: Icon,
  label,
  onClick,
  variant = 'default',
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  onClick: () => void;
  variant?: 'default' | 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex h-8 w-8 items-center justify-center rounded-lg transition-all ${
        variant === 'danger'
          ? 'text-text-subtle opacity-0 group-hover:opacity-100 hover:bg-error/10 hover:text-error'
          : 'text-text-subtle opacity-0 group-hover:opacity-100 hover:bg-bg-elevated hover:text-text'
      }`}
    >
      <Icon size={15} aria-hidden="true" />
    </button>
  );
}
