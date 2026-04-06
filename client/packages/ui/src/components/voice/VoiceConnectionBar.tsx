import { useChannelStore, useServerStore, useVoiceStore } from '@meza/core';
import {
  LockKey,
  MonitorArrowUpIcon,
  MonitorIcon,
  PhoneSlashIcon,
  UserSoundIcon,
} from '@phosphor-icons/react';
import { useScreenShareToggle } from '../../hooks/useScreenShareToggle.ts';
import { useVoiceConnection } from '../../hooks/useVoiceConnection.ts';
import { useTilingStore } from '../../stores/tiling.ts';
import { ScreenPickerDialog } from './ScreenPickerDialog.tsx';

/**
 * Compact bar shown in the sidebar when connected to a voice channel.
 * Provides disconnect and click-to-navigate to the voice pane.
 */
export function VoiceConnectionBar() {
  const status = useVoiceStore((s) => s.status);
  const channelName = useVoiceStore((s) => s.channelName);
  const channelId = useVoiceStore((s) => s.channelId);
  const serverId = useChannelStore((s) =>
    channelId ? s.channelToServer[channelId] : undefined,
  );
  const serverName = useServerStore((s) =>
    serverId ? s.servers[serverId]?.name : undefined,
  );

  if (status !== 'connected' && status !== 'reconnecting') return null;

  return (
    <div className="flex-shrink-0 bg-bg-overlay mx-1.5 px-3 pt-2 pb-1">
      <div className="flex items-center gap-2.5">
        {/* Status icon in squircle */}
        <div
          className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md ${
            status === 'connected'
              ? 'bg-success/8 text-success'
              : 'bg-warning/8 text-warning animate-pulse'
          }`}
        >
          <UserSoundIcon size={16} aria-hidden="true" />
        </div>

        {/* Stacked label + channel name */}
        <button
          type="button"
          className="flex flex-1 min-w-0 flex-col text-left hover:text-accent transition-colors"
          title={channelName ?? 'Voice Channel'}
          onClick={() => {
            if (!channelId) return;
            const { focusedPaneId, setPaneContent } = useTilingStore.getState();
            setPaneContent(focusedPaneId, { type: 'voice', channelId });
          }}
        >
          <span className="inline-flex items-center gap-1 truncate text-[11px] font-mono tracking-wide text-success">
            <LockKey size={10} weight="fill" aria-hidden="true" />
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

        {/* Controls rendered inside LiveKit context */}
        <VoiceBarControls />
      </div>
    </div>
  );
}

/** Inner controls that depend on the LiveKit room context. */
function VoiceBarControls() {
  const { disconnect } = useVoiceConnection();
  const status = useVoiceStore((s) => s.status);

  if (status !== 'connected') {
    return (
      <button
        type="button"
        onClick={disconnect}
        className="p-1 text-text-muted hover:text-text transition-colors"
        aria-label="Disconnect"
        title="Disconnect"
      >
        <PhoneSlashIcon size={22} aria-hidden="true" />
      </button>
    );
  }

  return <VoiceBarConnectedControls onDisconnect={disconnect} />;
}

function VoiceBarConnectedControls({
  onDisconnect,
}: {
  onDisconnect: () => void;
}) {
  const canScreenShare = useVoiceStore((s) => s.canScreenShare);
  const {
    toggle,
    isSharing,
    pickerOpen,
    sources,
    selectedSourceId,
    setSelectedSourceId,
    confirmShare,
    cancelPicker,
    pickerError,
    retryGetSources,
  } = useScreenShareToggle(canScreenShare);
  const showScreenShare =
    canScreenShare &&
    typeof navigator.mediaDevices?.getDisplayMedia === 'function';

  return (
    <div className="flex items-center gap-2">
      {/* Screen share toggle */}
      {showScreenShare && (
        <>
          <button
            type="button"
            onClick={toggle}
            className={`p-1 transition-colors ${
              isSharing
                ? 'text-success hover:text-success/80'
                : 'text-text-muted hover:text-text'
            }`}
            aria-label={isSharing ? 'Stop sharing screen' : 'Share screen'}
            title={isSharing ? 'Stop sharing screen' : 'Share screen'}
          >
            {isSharing ? (
              <MonitorIcon size={22} aria-hidden="true" />
            ) : (
              <MonitorArrowUpIcon size={22} aria-hidden="true" />
            )}
          </button>
          <ScreenPickerDialog
            open={pickerOpen}
            onOpenChange={(open) => {
              if (!open) cancelPicker();
            }}
            sources={sources}
            selectedSourceId={selectedSourceId}
            onSelectSource={setSelectedSourceId}
            onShare={confirmShare}
            onCancel={cancelPicker}
            error={pickerError}
            onRetry={retryGetSources}
          />
        </>
      )}

      {/* Disconnect */}
      <button
        type="button"
        onClick={onDisconnect}
        className="p-1 text-text-muted hover:text-text transition-colors"
        aria-label="Disconnect"
        title="Disconnect"
      >
        <PhoneSlashIcon size={22} aria-hidden="true" />
      </button>
    </div>
  );
}
