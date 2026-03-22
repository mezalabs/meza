import { useBotStore } from '@meza/core';
import * as Dialog from '@radix-ui/react-dialog';
import { type FormEvent, useEffect, useState } from 'react';

const USERNAME_REGEX = /^[a-z0-9_]{2,32}$/;

interface CreateBotDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (data: {
    token: string;
    privateKey: Uint8Array;
    botName: string;
  }) => void;
}

export function CreateBotDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateBotDialogProps) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usernameError, setUsernameError] = useState<string | null>(null);

  const createBot = useBotStore((s) => s.createBot);

  useEffect(() => {
    if (!open) {
      setUsername('');
      setDisplayName('');
      setError(null);
      setUsernameError(null);
      setLoading(false);
    }
  }, [open]);

  const validateUsername = (value: string) => {
    if (!value) {
      setUsernameError(null);
      return;
    }
    if (!USERNAME_REGEX.test(value)) {
      setUsernameError(
        'Use only lowercase letters, numbers, and underscores (2-32 chars)',
      );
    } else {
      setUsernameError(null);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedUsername = username.trim();
    const trimmedDisplay = displayName.trim();
    if (!trimmedUsername || !trimmedDisplay) return;

    if (!USERNAME_REGEX.test(trimmedUsername)) {
      setUsernameError(
        'Use only lowercase letters, numbers, and underscores (2-32 chars)',
      );
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await createBot(trimmedUsername, trimmedDisplay);
      if (result) {
        onCreated({
          token: result.token,
          privateKey: result.privateKey,
          botName: result.bot?.displayName || trimmedDisplay,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create bot');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 animate-fade-in" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg bg-bg-elevated p-6 shadow-lg animate-scale-in">
          <Dialog.Title className="text-lg font-semibold text-text">
            Create a Bot
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-muted">
            Bots can connect to your servers, send messages, and respond to
            events via the API.
          </Dialog.Description>

          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            <div>
              <label
                htmlFor="bot-username"
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-text-subtle"
              >
                Username
              </label>
              <input
                id="bot-username"
                type="text"
                value={username}
                onChange={(e) => {
                  const val = e.target.value.toLowerCase();
                  setUsername(val);
                  validateUsername(val);
                }}
                placeholder="my_cool_bot"
                maxLength={32}
                required
                disabled={loading}
                autoComplete="off"
                className="w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-50"
              />
              {usernameError && (
                <p className="mt-1 text-xs text-error">{usernameError}</p>
              )}
            </div>

            <div>
              <label
                htmlFor="bot-display-name"
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-text-subtle"
              >
                Display Name
              </label>
              <input
                id="bot-display-name"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="My Cool Bot"
                maxLength={100}
                required
                disabled={loading}
                className="w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-50"
              />
            </div>

            {error && <p className="text-xs text-error">{error}</p>}

            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <button
                  type="button"
                  disabled={loading}
                  className="rounded-md bg-bg-surface px-3 py-1.5 text-sm text-text-muted hover:bg-bg-elevated hover:text-text"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="submit"
                disabled={
                  loading ||
                  !username.trim() ||
                  !displayName.trim() ||
                  !!usernameError
                }
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-50"
              >
                {loading ? 'Creating...' : 'Create Bot'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
