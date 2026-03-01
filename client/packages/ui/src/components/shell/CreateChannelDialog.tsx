import { ChannelType, createChannel, useServerStore } from '@meza/core';
import { HashIcon, SpeakerHighIcon } from '@phosphor-icons/react';
import * as Dialog from '@radix-ui/react-dialog';
import { type FormEvent, useState } from 'react';
import { useTilingStore } from '../../stores/tiling.ts';

interface CreateChannelDialogProps {
  serverId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelGroupId?: string;
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

export function CreateChannelDialog({
  serverId,
  open,
  onOpenChange,
  channelGroupId,
}: CreateChannelDialogProps) {
  const serverDefault = useServerStore(
    (s) => s.servers[serverId]?.defaultChannelPrivacy ?? false,
  );
  const [name, setName] = useState('');
  const [channelType, setChannelType] = useState<ChannelType>(ChannelType.TEXT);
  const [isPrivate, setIsPrivate] = useState(serverDefault);
  const [validationError, setValidationError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const guardedOpenChange = (next: boolean) => {
    if (!next && isSubmitting) return;
    onOpenChange(next);
  };

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();

    if (name.length === 0) {
      setValidationError('Channel name is required');
      return;
    }
    if (name.length > 100) {
      setValidationError('Channel name must be 100 characters or fewer');
      return;
    }

    setValidationError('');
    setSubmitError('');
    setIsSubmitting(true);

    try {
      const channel = await createChannel(
        serverId,
        name,
        channelType,
        isPrivate,
        channelGroupId,
      );
      if (channel) {
        const { focusedPaneId, setPaneContent } = useTilingStore.getState();
        const isVoice = channelType === ChannelType.VOICE;
        setPaneContent(
          focusedPaneId,
          isVoice
            ? { type: 'voice', channelId: channel.id }
            : { type: 'channel', channelId: channel.id },
        );
        onOpenChange(false);
      } else {
        setSubmitError('Failed to create channel');
      }
    } catch (err) {
      const msg =
        err instanceof Error && err.message.includes('already exists')
          ? 'A channel with that name already exists'
          : 'Failed to create channel';
      setSubmitError(msg);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={guardedOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl bg-bg-elevated p-6 shadow-lg animate-scale-in"
          onEscapeKeyDown={(e) => {
            if (isSubmitting) e.preventDefault();
          }}
        >
          <Dialog.Title className="text-lg font-semibold text-text">
            Create Channel
          </Dialog.Title>

          <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="channel-name"
                className="text-xs font-semibold uppercase tracking-wider text-text-subtle"
              >
                Channel name
              </label>
              <input
                id="channel-name"
                type="text"
                value={name}
                onChange={(e) => {
                  setName(normalizeName(e.target.value));
                  setValidationError('');
                }}
                placeholder="new-channel"
                maxLength={100}
                disabled={isSubmitting}
                className="w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-50"
              />
              {validationError && (
                <p className="text-xs text-error">{validationError}</p>
              )}
            </div>

            {/* Channel type selector */}
            <fieldset className="flex flex-col gap-1.5" disabled={isSubmitting}>
              <legend className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
                Channel type
              </legend>
              <div className="flex gap-3">
                <label
                  className={`flex flex-1 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                    channelType === ChannelType.TEXT
                      ? 'border-accent bg-accent-subtle text-text'
                      : 'border-border bg-bg-surface text-text-muted hover:border-border-hover'
                  }`}
                >
                  <input
                    type="radio"
                    name="channel-type"
                    value="text"
                    checked={channelType === ChannelType.TEXT}
                    onChange={() => setChannelType(ChannelType.TEXT)}
                    className="sr-only"
                  />
                  <HashIcon weight="regular" size={16} aria-hidden="true" />
                  <span>Text</span>
                </label>
                <label
                  className={`flex flex-1 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                    channelType === ChannelType.VOICE
                      ? 'border-accent bg-accent-subtle text-text'
                      : 'border-border bg-bg-surface text-text-muted hover:border-border-hover'
                  }`}
                >
                  <input
                    type="radio"
                    name="channel-type"
                    value="voice"
                    checked={channelType === ChannelType.VOICE}
                    onChange={() => setChannelType(ChannelType.VOICE)}
                    className="sr-only"
                  />
                  <SpeakerHighIcon size={16} aria-hidden="true" />
                  <span>Voice</span>
                </label>
              </div>
            </fieldset>

            {/* Private channel toggle */}
            <label className="flex items-center gap-3 cursor-pointer">
              <div className="relative">
                <input
                  type="checkbox"
                  checked={isPrivate}
                  onChange={(e) => setIsPrivate(e.target.checked)}
                  disabled={isSubmitting}
                  className="sr-only peer"
                />
                <div className="h-5 w-9 rounded-full bg-bg-surface border border-border transition-colors peer-checked:bg-accent peer-checked:border-accent peer-disabled:opacity-50" />
                <div className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-text-muted transition-all peer-checked:translate-x-4 peer-checked:bg-black" />
              </div>
              <div className="flex flex-col">
                <span className="text-sm text-text">Private Channel</span>
                <span className="text-xs text-text-muted">
                  Only visible to members you explicitly add
                </span>
              </div>
            </label>

            {submitError && <p className="text-xs text-error">{submitError}</p>}

            <div className="flex justify-end gap-2">
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
                type="submit"
                disabled={isSubmitting}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-accent-hover disabled:opacity-50"
              >
                {isSubmitting ? 'Creating...' : 'Create'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
