import { useBotStore } from '@meza/core';
import type { Bot } from '@meza/core';
import {
  DotsThreeIcon,
  PencilSimpleIcon,
  ArrowsClockwiseIcon,
  LinkSimpleIcon,
  TrashIcon,
  PlusIcon,
  RobotIcon,
} from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { Avatar } from '../shared/Avatar.tsx';
import { BotInviteDialog } from './BotInviteDialog.tsx';
import { BotTokenModal } from './BotTokenModal.tsx';
import { CreateBotDialog } from './CreateBotDialog.tsx';
import { EditBotDialog } from './EditBotDialog.tsx';

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
  const [menuBotId, setMenuBotId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    fetchBots();
  }, [fetchBots]);

  const handleRegenerate = async (bot: Bot) => {
    setActionLoading(bot.id);
    setMenuBotId(null);
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
    setMenuBotId(null);
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
    <div className="max-w-md space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
          My Bots
        </h2>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-black hover:bg-accent-hover transition-colors"
        >
          <PlusIcon size={14} aria-hidden="true" />
          Create Bot
        </button>
      </div>

      {error && (
        <p className="text-xs text-error">{error}</p>
      )}

      {loading && bots.length === 0 && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 animate-pulse">
              <div className="h-8 w-8 rounded-full bg-bg-surface" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3.5 w-24 rounded bg-bg-surface" />
                <div className="h-3 w-40 rounded bg-bg-surface" />
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && bots.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border/40 bg-bg-surface/50 py-10">
          <RobotIcon
            size={40}
            className="text-text-muted"
            aria-hidden="true"
          />
          <div className="text-center">
            <p className="text-sm font-medium text-text">No bots yet</p>
            <p className="mt-1 text-xs text-text-muted">
              Create a bot to automate tasks and integrate with external
              services.
            </p>
          </div>
        </div>
      )}

      {bots.length > 0 && (
        <div className="space-y-2">
          {bots.map((bot) => (
            <div
              key={bot.id}
              className="relative flex items-center gap-3 rounded-lg border border-border/40 bg-bg-surface/50 p-3 transition-colors hover:bg-bg-surface"
            >
              <Avatar
                avatarUrl={bot.avatarUrl}
                displayName={bot.displayName || bot.username}
                size="lg"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-text">
                    {bot.displayName || bot.username}
                  </span>
                  <RobotIcon
                    size={12}
                    className="flex-shrink-0 text-text-muted"
                    aria-hidden="true"
                  />
                </div>
                <span className="block truncate text-xs text-text-muted">
                  @{bot.username}
                </span>
                {bot.description && (
                  <span className="mt-0.5 block truncate text-xs text-text-muted">
                    {bot.description}
                  </span>
                )}
                <span className="mt-0.5 block text-[10px] text-text-subtle">
                  Created {formatDate(bot.createdAt)}
                </span>
              </div>

              {actionLoading === bot.id ? (
                <div className="flex-shrink-0 h-7 w-7 flex items-center justify-center">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-text-muted border-t-transparent" />
                </div>
              ) : (
                <div className="relative flex-shrink-0">
                  <button
                    type="button"
                    onClick={() =>
                      setMenuBotId(menuBotId === bot.id ? null : bot.id)
                    }
                    className="rounded-md p-1.5 text-text-muted hover:bg-bg-elevated hover:text-text transition-colors"
                    aria-label={`Actions for ${bot.displayName || bot.username}`}
                  >
                    <DotsThreeIcon size={16} weight="bold" aria-hidden="true" />
                  </button>

                  {menuBotId === bot.id && (
                    <>
                      {/* Backdrop to close menu */}
                      <div
                        className="fixed inset-0 z-40"
                        onClick={() => setMenuBotId(null)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') setMenuBotId(null);
                        }}
                        role="presentation"
                      />
                      <div className="absolute right-0 top-full z-50 mt-1 w-48 rounded-md border border-border bg-bg-elevated py-1 shadow-lg">
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-text-muted hover:bg-bg-surface hover:text-text transition-colors"
                          onClick={() => {
                            setEditBot(bot);
                            setMenuBotId(null);
                          }}
                        >
                          <PencilSimpleIcon size={14} aria-hidden="true" />
                          Edit
                        </button>
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-text-muted hover:bg-bg-surface hover:text-text transition-colors"
                          onClick={() => handleRegenerate(bot)}
                        >
                          <ArrowsClockwiseIcon size={14} aria-hidden="true" />
                          Regenerate Token
                        </button>
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-text-muted hover:bg-bg-surface hover:text-text transition-colors"
                          onClick={() => {
                            setInviteBot(bot);
                            setMenuBotId(null);
                          }}
                        >
                          <LinkSimpleIcon size={14} aria-hidden="true" />
                          Generate Invite
                        </button>
                        <div className="my-1 border-t border-border" />
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-danger hover:bg-bg-surface transition-colors"
                          onClick={() => {
                            setConfirmDelete(bot.id);
                            setMenuBotId(null);
                          }}
                        >
                          <TrashIcon size={14} aria-hidden="true" />
                          Delete
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Delete confirmation inline */}
              {confirmDelete === bot.id && (
                <div className="absolute inset-0 z-30 flex items-center justify-center rounded-lg bg-bg-surface/95 backdrop-blur-sm">
                  <div className="text-center">
                    <p className="text-sm text-text">Delete this bot?</p>
                    <p className="mt-1 text-xs text-text-muted">
                      This action cannot be undone.
                    </p>
                    <div className="mt-2 flex justify-center gap-2">
                      <button
                        type="button"
                        className="rounded-md bg-bg-elevated px-3 py-1 text-xs text-text-muted hover:text-text transition-colors"
                        onClick={() => setConfirmDelete(null)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="rounded-md bg-danger px-3 py-1 text-xs text-white hover:bg-danger/80 transition-colors"
                        onClick={() => handleDelete(bot.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

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
