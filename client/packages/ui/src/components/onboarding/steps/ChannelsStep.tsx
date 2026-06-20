import {
  ChannelType,
  type TemplateChannel,
  type TemplateChannelGroup,
} from '@meza/core';
import {
  HashIcon,
  LockSimpleIcon,
  SpeakerHighIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useCallback, useState } from 'react';

interface ChannelsStepProps {
  channels: TemplateChannel[];
  onChannelsChange: (channels: TemplateChannel[]) => void;
  channelGroups: TemplateChannelGroup[];
}

export function ChannelsStep({
  channels,
  onChannelsChange,
  channelGroups,
}: ChannelsStepProps) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  const textChannels = channels.filter((c) => c.type === ChannelType.TEXT);
  const voiceChannels = channels.filter((c) => c.type === ChannelType.VOICE);

  const handleRemove = useCallback(
    (index: number) => {
      const updated = channels.filter((_, i) => i !== index);
      onChannelsChange(updated);
    },
    [channels, onChannelsChange],
  );

  const handleRename = useCallback(
    (index: number, newName: string) => {
      const updated = channels.map((ch, i) =>
        i === index ? { ...ch, name: newName } : ch,
      );
      onChannelsChange(updated);
      setEditingIndex(null);
    },
    [channels, onChannelsChange],
  );

  const hasAtLeastOneText = textChannels.length > 0;

  const renderTextChannelRow = (ch: TemplateChannel, i: number) => {
    const canRemove = textChannels.length > 1;
    return (
      <div
        key={`${ch.name}-${i}`}
        className="flex items-center gap-2 rounded-lg bg-bg-surface px-3 py-2"
      >
        <span className="text-text-muted">
          {ch.isPrivate ? (
            <span className="relative" role="img" aria-label="Private channel">
              <HashIcon weight="regular" size={14} aria-hidden="true" />
              <span className="absolute -bottom-1 -right-1.5 flex h-3 w-3 items-center justify-center rounded-full bg-bg-surface">
                <LockSimpleIcon
                  size={8}
                  weight="fill"
                  className="text-text-subtle"
                  aria-hidden="true"
                />
              </span>
            </span>
          ) : (
            <HashIcon weight="regular" size={14} aria-hidden="true" />
          )}
        </span>
        {editingIndex === i ? (
          <input
            type="text"
            defaultValue={ch.name}
            onBlur={(e) => handleRename(i, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename(i, e.currentTarget.value);
              if (e.key === 'Escape') setEditingIndex(null);
            }}
            className="flex-1 rounded-none bg-transparent p-0 text-sm text-text focus:outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditingIndex(i)}
            className="flex-1 text-left text-sm text-text hover:text-accent"
          >
            {ch.name}
          </button>
        )}
        {ch.isDefault && (
          <span className="text-xs text-text-muted">default</span>
        )}
        {ch.isPrivate && ch.roleNames && ch.roleNames.length > 0 && (
          <span className="rounded bg-bg-elevated px-1.5 py-0.5 text-xs text-text-muted">
            {ch.roleNames.join(', ')}
          </span>
        )}
        {canRemove && (
          <button
            type="button"
            onClick={() => handleRemove(i)}
            className="text-xs text-text-muted hover:text-error"
            aria-label={`Remove ${ch.name}`}
          >
            <XIcon weight="regular" size={14} aria-hidden="true" />
          </button>
        )}
      </div>
    );
  };

  // Build index-preserving entries so callbacks still receive the original
  // index into `channels` (rename/remove use that index directly).
  const textEntries = channels
    .map((ch, i) => ({ ch, i }))
    .filter(({ ch }) => ch.type === ChannelType.TEXT);

  const ungroupedText = textEntries.filter(
    ({ ch }) => !ch.groupName || ch.groupName.length === 0,
  );

  return (
    <div className="space-y-4">
      <div className="text-center">
        <h2 className="text-lg font-semibold text-text">Customize channels</h2>
        <p className="mt-1 text-sm text-text-muted">
          Rename or remove channels you don't need. At least one text channel is
          required.
        </p>
        <p className="mt-1 text-sm text-text-muted">
          You can add more channels after your server is created.
        </p>
      </div>

      {/* Text channels */}
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
          Text Channels
        </h3>
        {channelGroups.length === 0 ? (
          <div className="space-y-1">
            {textEntries.map(({ ch, i }) => renderTextChannelRow(ch, i))}
          </div>
        ) : (
          <div className="space-y-3">
            {channelGroups.map((group) => {
              const entries = textEntries.filter(
                ({ ch }) => ch.groupName === group.name,
              );
              if (entries.length === 0) return null;
              return (
                <div key={group.name}>
                  <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
                    {group.name}
                  </h4>
                  <div className="space-y-1">
                    {entries.map(({ ch, i }) => renderTextChannelRow(ch, i))}
                  </div>
                </div>
              );
            })}
            {ungroupedText.length > 0 && (
              <div>
                <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
                  Ungrouped
                </h4>
                <div className="space-y-1">
                  {ungroupedText.map(({ ch, i }) =>
                    renderTextChannelRow(ch, i),
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Voice channels */}
      {voiceChannels.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
            Voice Channels
          </h3>
          <div className="space-y-1">
            {channels.map((ch, i) => {
              if (ch.type !== ChannelType.VOICE) return null;
              return (
                <div
                  key={`${ch.name}-${i}`}
                  className="flex items-center gap-2 rounded-lg bg-bg-surface px-3 py-2"
                >
                  <span className="text-text-muted">
                    <SpeakerHighIcon size={14} aria-hidden="true" />
                  </span>
                  {editingIndex === i ? (
                    <input
                      type="text"
                      defaultValue={ch.name}
                      onBlur={(e) => handleRename(i, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter')
                          handleRename(i, e.currentTarget.value);
                        if (e.key === 'Escape') setEditingIndex(null);
                      }}
                      className="flex-1 rounded-none bg-transparent p-0 text-sm text-text focus:outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setEditingIndex(i)}
                      className="flex-1 text-left text-sm text-text hover:text-accent"
                    >
                      {ch.name}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleRemove(i)}
                    className="text-xs text-text-muted hover:text-error"
                    aria-label={`Remove ${ch.name}`}
                  >
                    <XIcon weight="regular" size={14} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!hasAtLeastOneText && (
        <p className="text-xs text-error">
          At least one text channel is required.
        </p>
      )}
    </div>
  );
}
