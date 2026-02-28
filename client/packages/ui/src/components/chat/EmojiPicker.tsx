import {
  getMediaURL,
  listEmojis,
  listUserEmojis,
  useEmojiStore,
} from '@meza/core';
import { memo, useCallback, useEffect, useState } from 'react';

// emoji-mart data is an opaque JSON blob consumed by the Picker component.
// @emoji-mart/data does not export a usable type definition.
type EmojiData = Record<string, unknown>;

// Hand-written props for emoji-mart Picker v5.6.x
// Ref: https://github.com/missive/emoji-mart#options--props
interface EmojiMartPickerProps {
  data: EmojiData;
  onEmojiSelect: (emoji: { native: string }) => void;
  theme: 'dark' | 'light' | 'auto';
  set: 'native' | 'apple' | 'google' | 'twitter' | 'facebook';
  perLine: number;
  emojiSize: number;
  emojiButtonSize: number;
  previewPosition: 'none' | 'bottom' | 'top';
  skinTonePosition: 'none' | 'search' | 'preview';
  maxFrequentRows?: number;
  autoFocus?: boolean;
}

// Module-scope cache -- survives component unmount/remount (pane rearrangement)
let cachedData: EmojiData | null = null;
let cachedPicker: React.ComponentType<EmojiMartPickerProps> | null = null;
let loadPromise: Promise<void> | null = null;

function loadEmojiMart(): Promise<void> {
  if (!loadPromise) {
    loadPromise = Promise.all([
      import('@emoji-mart/data'),
      import('@emoji-mart/react'),
    ])
      .then(([dataModule, pickerModule]) => {
        cachedData = dataModule.default as EmojiData;
        cachedPicker =
          pickerModule.default as React.ComponentType<EmojiMartPickerProps>;
      })
      .catch((err) => {
        loadPromise = null; // Allow retry on next open
        throw err;
      });
  }
  return loadPromise;
}

interface EmojiPickerProps {
  onEmojiSelect: (text: string) => void;
  serverId?: string;
}

export const EmojiPicker = memo(function EmojiPicker({
  onEmojiSelect,
  serverId,
}: EmojiPickerProps) {
  const [, forceUpdate] = useState(0);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (cachedData && cachedPicker) return;
    let cancelled = false;
    loadEmojiMart()
      .then(() => {
        if (!cancelled) forceUpdate((n) => n + 1);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Clean up emoji-mart localStorage keys on unmount (privacy)
  useEffect(() => {
    return () => {
      Object.keys(localStorage)
        .filter((k) => k.startsWith('emoji-mart.'))
        // biome-ignore lint/suspicious/useIterableCallbackReturn: forEach cleanup does not need a return
        .forEach((k) => localStorage.removeItem(k));
    };
  }, []);

  const handleSelect = useCallback(
    (emoji: { native: string }) => onEmojiSelect(emoji.native),
    [onEmojiSelect],
  );

  if (loadError) {
    return (
      <div className="flex h-[435px] w-[352px] items-center justify-center rounded-xl bg-bg-elevated">
        <span className="text-sm text-text-muted">
          Failed to load emoji picker
        </span>
      </div>
    );
  }

  if (!cachedData || !cachedPicker) {
    return (
      <div className="flex h-[435px] w-[352px] items-center justify-center rounded-xl bg-bg-elevated">
        <span className="text-sm text-text-muted">Loading emoji…</span>
      </div>
    );
  }

  const Picker = cachedPicker;
  return (
    <div>
      <Picker
        data={cachedData}
        onEmojiSelect={handleSelect}
        theme="dark"
        set="native"
        perLine={9}
        emojiSize={24}
        emojiButtonSize={36}
        previewPosition="none"
        skinTonePosition="search"
        maxFrequentRows={0}
        autoFocus
      />
      <CustomEmojiGrid serverId={serverId} onSelect={onEmojiSelect} />
    </div>
  );
});

function CustomEmojiGrid({
  serverId,
  onSelect,
}: {
  serverId?: string;
  onSelect: (text: string) => void;
}) {
  const serverEmojis = useEmojiStore((s) =>
    serverId ? s.byServer[serverId] : undefined,
  );
  const personalEmojis = useEmojiStore((s) => s.personal);

  // Fetch server emojis on mount if not already loaded
  useEffect(() => {
    if (serverId && !serverEmojis) {
      listEmojis(serverId).catch(() => {});
    }
  }, [serverId, serverEmojis]);

  // Fetch personal emojis on mount if not already loaded
  useEffect(() => {
    if (personalEmojis.length === 0) {
      listUserEmojis().catch(() => {});
    }
  }, [personalEmojis.length]);

  const hasPersonal = personalEmojis.length > 0;
  const hasServer = serverEmojis && serverEmojis.length > 0;

  if (!hasPersonal && !hasServer) return null;

  return (
    <div className="border-t border-border bg-bg-elevated px-3 py-2">
      {hasPersonal && (
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-text-subtle">
            My Emojis
          </p>
          <div className="flex flex-wrap gap-1">
            {personalEmojis.map((emoji) => {
              const attachmentId = emoji.imageUrl.replace('/media/', '');
              const ref = emoji.animated
                ? `<a:${emoji.name}:${emoji.id}>`
                : `<:${emoji.name}:${emoji.id}>`;
              return (
                <button
                  key={emoji.id}
                  type="button"
                  title={`:${emoji.name}:`}
                  className="flex h-9 w-9 items-center justify-center rounded hover:bg-bg-surface"
                  onClick={() => onSelect(ref)}
                >
                  <img
                    src={getMediaURL(attachmentId)}
                    alt={`:${emoji.name}:`}
                    className="h-6 w-6 object-contain"
                    loading="lazy"
                  />
                </button>
              );
            })}
          </div>
        </div>
      )}
      {hasServer && (
        <div className={hasPersonal ? 'mt-2' : ''}>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-text-subtle">
            Server Emojis
          </p>
          <div className="flex flex-wrap gap-1">
            {serverEmojis.map((emoji) => {
              const attachmentId = emoji.imageUrl.replace('/media/', '');
              const ref = emoji.animated
                ? `<a:${emoji.name}:${emoji.id}>`
                : `<:${emoji.name}:${emoji.id}>`;
              return (
                <button
                  key={emoji.id}
                  type="button"
                  title={`:${emoji.name}:`}
                  className="flex h-9 w-9 items-center justify-center rounded hover:bg-bg-surface"
                  onClick={() => onSelect(ref)}
                >
                  <img
                    src={getMediaURL(attachmentId)}
                    alt={`:${emoji.name}:`}
                    className="h-6 w-6 object-contain"
                    loading="lazy"
                  />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
