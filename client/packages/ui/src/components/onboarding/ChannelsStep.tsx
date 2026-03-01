import type { Channel } from '@meza/core';
import { CheckIcon } from '@phosphor-icons/react';

interface ChannelsStepProps {
  channels: Channel[];
  selectedIds: Set<string>;
  onSelectionChange: (ids: Set<string>) => void;
  readOnly: boolean;
}

export function ChannelsStep({
  channels,
  selectedIds,
  onSelectionChange,
  readOnly,
}: ChannelsStepProps) {
  const toggleChannel = (id: string) => {
    if (readOnly) return;
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onSelectionChange(next);
  };

  const toggleAll = () => {
    if (readOnly) return;
    if (selectedIds.size === channels.length) {
      onSelectionChange(new Set());
    } else {
      onSelectionChange(new Set(channels.map((c) => c.id)));
    }
  };

  return (
    <div className="flex flex-col">
      <h2 className="mb-1 text-xl font-semibold text-text">
        Choose Your Channels
      </h2>
      <p className="mb-4 text-sm text-text-muted">
        Select the channels you'd like to join
      </p>

      {!readOnly && channels.length > 1 && (
        <button
          type="button"
          onClick={toggleAll}
          className="mb-3 self-start text-xs text-accent hover:underline"
        >
          {selectedIds.size === channels.length ? 'Deselect all' : 'Select all'}
        </button>
      )}

      <div className="space-y-1.5">
        {channels.map((ch) => (
          <button
            key={ch.id}
            type="button"
            onClick={() => toggleChannel(ch.id)}
            disabled={readOnly}
            className={`flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
              selectedIds.has(ch.id)
                ? 'border-accent bg-accent-subtle'
                : 'border-border bg-bg-surface hover:bg-bg-elevated'
            } ${readOnly ? 'cursor-default' : ''}`}
          >
            <span className="text-text-subtle">#</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-text truncate">
                  {ch.name}
                </span>
                {ch.isDefault && (
                  <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                    Recommended
                  </span>
                )}
              </div>
              {ch.topic && (
                <p className="mt-0.5 text-xs text-text-muted truncate">
                  {ch.topic}
                </p>
              )}
            </div>
            {!readOnly && (
              <div
                className={`h-4 w-4 rounded border ${
                  selectedIds.has(ch.id)
                    ? 'border-accent bg-accent'
                    : 'border-border'
                }`}
              >
                {selectedIds.has(ch.id) && (
                  <CheckIcon
                    size={16}
                    className="text-black"
                    aria-hidden="true"
                  />
                )}
              </div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
