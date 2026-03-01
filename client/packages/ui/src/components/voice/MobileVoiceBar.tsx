import { useChannelStore, useServerStore, useVoiceStore } from '@meza/core';
import {
  ArrowSquareOutIcon,
  PhoneSlashIcon,
  UserSoundIcon,
} from '@phosphor-icons/react';
import { useVoiceConnection } from '../../hooks/useVoiceConnection.ts';
import { useNavigationStore } from '../../stores/navigation.ts';

/**
 * Compact persistent bar shown on mobile when the user is in a voice call.
 * Appears above the sidebar footer or above the composer in the channel view.
 * Tap to open voice fullscreen, X to disconnect.
 */
export function MobileVoiceBar() {
  const status = useVoiceStore((s) => s.status);
  const channelName = useVoiceStore((s) => s.channelName);
  const channelId = useVoiceStore((s) => s.channelId);
  const serverId = useChannelStore((s) =>
    channelId ? s.channelToServer[channelId] : undefined,
  );
  const serverName = useServerStore((s) =>
    serverId ? s.servers[serverId]?.name : undefined,
  );
  const { disconnect } = useVoiceConnection();
  const openMobileVoice = useNavigationStore((s) => s.openMobileVoice);

  if (status !== 'connected' && status !== 'reconnecting') return null;

  return (
    <div className="flex-shrink-0 mx-1.5 px-3 py-2 bg-bg-surface rounded-lg border border-border/50">
      <div className="flex items-center gap-2.5">
        <div
          className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md ${
            status === 'connected'
              ? 'bg-success/8 text-success'
              : 'bg-warning/8 text-warning animate-pulse'
          }`}
        >
          <UserSoundIcon size={16} aria-hidden="true" />
        </div>

        <button
          type="button"
          className="flex flex-1 min-w-0 flex-col text-left"
          onClick={openMobileVoice}
        >
          <span className="truncate text-[11px] font-mono tracking-wide text-success">
            Voice Connected
          </span>
          <span className="truncate text-xs text-text">
            {channelName ?? 'Voice Channel'}
            {serverName ? (
              <span className="text-text-muted font-normal">
                {' '}
                / {serverName}
              </span>
            ) : null}
          </span>
        </button>

        <button
          type="button"
          onClick={openMobileVoice}
          className="p-2 text-text-muted hover:text-text transition-colors"
          aria-label="Open voice"
          title="Open voice"
        >
          <ArrowSquareOutIcon size={20} aria-hidden="true" />
        </button>

        <button
          type="button"
          onClick={disconnect}
          className="p-2 text-error hover:text-error/80 transition-colors"
          aria-label="Disconnect"
          title="Disconnect"
        >
          <PhoneSlashIcon size={20} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
