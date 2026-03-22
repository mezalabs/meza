import {
  createBotInvite,
  deleteBotInvite,
  listBotInvites,
  PERMISSION_INFO,
  Permissions,
  type Bot,
  type BotInvite,
  type PermissionKey,
} from '@meza/core';
import * as Dialog from '@radix-ui/react-dialog';
import {
  CheckIcon,
  CopyIcon,
  TrashIcon,
  WarningIcon,
} from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

/** All permissions available for bot invites. */
const BOT_PERMISSION_KEYS: PermissionKey[] = [
  'VIEW_CHANNEL',
  'SEND_MESSAGES',
  'EMBED_LINKS',
  'ATTACH_FILES',
  'ADD_REACTIONS',
  'READ_MESSAGE_HISTORY',
  'USE_EXTERNAL_EMOJIS',
  'MANAGE_MESSAGES',
  'MANAGE_CHANNELS',
  'MANAGE_ROLES',
  'MANAGE_EMOJIS',
  'MANAGE_SERVER',
  'KICK_MEMBERS',
  'BAN_MEMBERS',
  'ADMINISTRATOR',
];

interface BotInviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bot: Bot;
}

export function BotInviteDialog({
  open,
  onOpenChange,
  bot,
}: BotInviteDialogProps) {
  const [selectedPerms, setSelectedPerms] = useState<bigint>(0n);
  const [invites, setInvites] = useState<BotInvite[]>([]);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingInvites, setLoadingInvites] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingCode, setDeletingCode] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setSelectedPerms(0n);
      setGeneratedUrl(null);
      setCopied(false);
      setError(null);
      setInvites([]);
      return;
    }

    setLoadingInvites(true);
    listBotInvites(bot.id)
      .then(setInvites)
      .catch(() => {})
      .finally(() => setLoadingInvites(false));
  }, [open, bot.id]);

  const togglePerm = (key: PermissionKey) => {
    const bit = Permissions[key];
    setSelectedPerms((prev) => (prev & bit ? prev & ~bit : prev | bit));
  };

  const isAdminSelected = !!(selectedPerms & Permissions.ADMINISTRATOR);

  const handleGenerate = async () => {
    if (selectedPerms === 0n) return;
    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      const invite = await createBotInvite(bot.id, selectedPerms);
      if (invite) {
        const url = `${window.location.origin}/bot-invite/${invite.code}`;
        setGeneratedUrl(url);
        setInvites((prev) => [invite, ...prev]);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to generate invite',
      );
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!generatedUrl) return;
    try {
      await navigator.clipboard.writeText(generatedUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const handleDeleteInvite = async (code: string) => {
    setDeletingCode(code);
    try {
      await deleteBotInvite(code);
      setInvites((prev) => prev.filter((i) => i.code !== code));
    } catch {
      // ignore
    } finally {
      setDeletingCode(null);
    }
  };

  const formatPerms = (bits: bigint): string => {
    const names: string[] = [];
    for (const key of BOT_PERMISSION_KEYS) {
      if (bits & Permissions[key]) {
        names.push(PERMISSION_INFO[key].name);
      }
    }
    return names.join(', ') || 'None';
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 animate-fade-in" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md max-h-[80vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg bg-bg-elevated p-6 shadow-lg animate-scale-in">
          <Dialog.Title className="text-lg font-semibold text-text">
            Bot Invite: {bot.displayName || bot.username}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-muted">
            Generate an invite link so server admins can add this bot.
          </Dialog.Description>

          {/* Permission selection */}
          <div className="mt-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-subtle">
              Requested Permissions
            </h3>

            {isAdminSelected && (
              <div className="mb-3 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-2.5">
                <WarningIcon
                  size={16}
                  className="mt-0.5 flex-shrink-0 text-warning"
                  aria-hidden="true"
                />
                <p className="text-xs text-warning">
                  Administrator grants full access to the server. Only select
                  this if your bot truly needs it.
                </p>
              </div>
            )}

            <div className="space-y-1.5 max-h-48 overflow-y-auto rounded-md border border-border bg-bg-surface p-2">
              {BOT_PERMISSION_KEYS.map((key) => {
                const info = PERMISSION_INFO[key];
                const bit = Permissions[key];
                const checked = !!(selectedPerms & bit);
                return (
                  <label
                    key={key}
                    className="flex items-start gap-2 cursor-pointer rounded px-1.5 py-1 hover:bg-bg-elevated transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => togglePerm(key)}
                      className="mt-0.5 h-3.5 w-3.5 rounded border-border accent-accent"
                    />
                    <div className="min-w-0">
                      <span className="block text-sm text-text">
                        {info.name}
                      </span>
                      <span className="block text-xs text-text-muted">
                        {info.description}
                      </span>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              onClick={handleGenerate}
              disabled={loading || selectedPerms === 0n}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-50"
            >
              {loading ? 'Generating...' : 'Generate Invite Link'}
            </button>
          </div>

          {error && <p className="mt-2 text-xs text-error">{error}</p>}

          {generatedUrl && (
            <div className="mt-3 flex items-center gap-2">
              <div
                className="flex-1 truncate rounded-md border border-border bg-bg-surface px-3 py-2 font-mono text-xs text-text select-all"
                title={generatedUrl}
              >
                {generatedUrl}
              </div>
              <button
                type="button"
                onClick={handleCopy}
                className="flex-shrink-0 rounded-md bg-bg-surface p-2 text-text-muted hover:text-text transition-colors"
                aria-label="Copy invite link"
              >
                {copied ? (
                  <CheckIcon size={16} aria-hidden="true" />
                ) : (
                  <CopyIcon size={16} aria-hidden="true" />
                )}
              </button>
            </div>
          )}

          {/* Existing invites */}
          {(invites.length > 0 || loadingInvites) && (
            <div className="mt-5">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-subtle">
                Existing Invites
              </h3>

              {loadingInvites ? (
                <div className="space-y-2">
                  {[1, 2].map((i) => (
                    <div
                      key={i}
                      className="h-10 animate-pulse rounded-md bg-bg-surface"
                    />
                  ))}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {invites.map((invite) => (
                    <div
                      key={invite.code}
                      className="flex items-center gap-2 rounded-md border border-border/40 bg-bg-surface/50 px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <code className="block truncate text-xs text-text">
                          {invite.code}
                        </code>
                        <span className="block truncate text-[10px] text-text-muted">
                          {formatPerms(invite.requestedPermissions)}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleDeleteInvite(invite.code)}
                        disabled={deletingCode === invite.code}
                        className="flex-shrink-0 rounded p-1 text-text-muted hover:text-danger transition-colors disabled:opacity-50"
                        aria-label={`Delete invite ${invite.code}`}
                      >
                        {deletingCode === invite.code ? (
                          <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-text-muted border-t-transparent" />
                        ) : (
                          <TrashIcon size={14} aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="mt-4 flex justify-end">
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-md bg-bg-surface px-3 py-1.5 text-sm text-text-muted hover:bg-bg-elevated hover:text-text"
              >
                Done
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
