/**
 * VoiceChannelView — In-call UI for voice channels.
 *
 * Shows participant list with mute indicators, mute/unmute toggle,
 * and disconnect button. Designed for the voice channel screen.
 */

import { useParticipants, useLocalParticipant } from '@livekit/react-native';
import {
  useUsersStore,
  useVoiceParticipantsStore,
  useVoiceStore,
} from '@meza/core';
import { RoomEvent, Track } from 'livekit-client';
import { useCallback, useMemo } from 'react';
import {
  FlatList,
  Pressable,
  Text,
  View,
} from 'react-native';
import { useVoiceConnection } from '@/hooks/useVoiceConnection';

interface VoiceChannelViewProps {
  channelId: string;
  channelName: string;
}

export function VoiceChannelView({
  channelId,
  channelName,
}: VoiceChannelViewProps) {
  const voiceStatus = useVoiceStore((s) => s.status);
  const voiceChannelId = useVoiceStore((s) => s.channelId);
  const error = useVoiceStore((s) => s.error);
  const isConnectedHere =
    voiceStatus === 'connected' && voiceChannelId === channelId;
  const isConnecting =
    voiceStatus === 'connecting' && voiceChannelId === channelId;

  return (
    <View className="flex-1 bg-bg-base">
      {/* Header */}
      <View className="items-center border-b border-border bg-bg-surface pb-4 pt-14">
        <Text className="text-lg font-bold text-text">{channelName}</Text>
        {(isConnectedHere || isConnecting) && (
          <View
            className={`mt-2 rounded-full px-3 py-1 ${
              isConnectedHere ? 'bg-success/20' : 'bg-warning/20'
            }`}
          >
            <Text
              className={`text-xs font-medium ${
                isConnectedHere ? 'text-success' : 'text-warning'
              }`}
            >
              {isConnectedHere ? 'Connected' : 'Connecting...'}
            </Text>
          </View>
        )}
        {voiceStatus === 'reconnecting' && voiceChannelId === channelId && (
          <View className="mt-2 rounded-full bg-warning/20 px-3 py-1">
            <Text className="text-xs font-medium text-warning">
              Reconnecting...
            </Text>
          </View>
        )}
      </View>

      {/* Error */}
      {error && (
        <View className="mx-4 mt-4 rounded-lg bg-error/10 px-4 py-3">
          <Text className="text-xs text-error">{error}</Text>
        </View>
      )}

      {/* Content */}
      {isConnectedHere ? (
        <ConnectedContent channelId={channelId} />
      ) : (
        <DisconnectedContent
          channelId={channelId}
          channelName={channelName}
          isConnecting={isConnecting}
        />
      )}
    </View>
  );
}

function DisconnectedContent({
  channelId,
  channelName,
  isConnecting,
}: {
  channelId: string;
  channelName: string;
  isConnecting: boolean;
}) {
  const { connect } = useVoiceConnection();
  const voiceStatus = useVoiceStore((s) => s.status);
  const isConnectedElsewhere =
    voiceStatus === 'connected' &&
    useVoiceStore.getState().channelId !== channelId;

  return (
    <View className="flex-1 items-center justify-center px-4">
      <Text className="mb-2 text-4xl">🔊</Text>
      <Text className="mb-1 text-base font-medium text-text">
        Voice Channel
      </Text>
      <Text className="mb-6 text-center text-sm text-text-muted">
        {isConnectedElsewhere
          ? 'You are connected to another voice channel.'
          : 'Join to start talking with others.'}
      </Text>
      <Pressable
        onPress={() => connect(channelId, channelName)}
        disabled={isConnecting}
        className="rounded-lg bg-accent px-6 py-3 active:bg-accent-hover disabled:opacity-50"
      >
        <Text className="text-sm font-medium text-black">
          {isConnecting
            ? 'Connecting...'
            : isConnectedElsewhere
              ? 'Switch Channel'
              : 'Join Voice'}
        </Text>
      </Pressable>
    </View>
  );
}

function ConnectedContent({ channelId }: { channelId: string }) {
  const { disconnect } = useVoiceConnection();
  const participants = useParticipants({
    updateOnlyOn: [
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
    ],
  });
  const { localParticipant } = useLocalParticipant();
  const isMicEnabled = localParticipant.isMicrophoneEnabled;

  const toggleMute = useCallback(async () => {
    await localParticipant.setMicrophoneEnabled(!isMicEnabled);
  }, [localParticipant, isMicEnabled]);

  return (
    <View className="flex-1">
      {/* Participants */}
      <FlatList
        data={participants}
        keyExtractor={(p) => p.identity}
        contentContainerStyle={{ padding: 16 }}
        renderItem={({ item }) => (
          <ParticipantRow
            identity={item.identity}
            isMuted={!item.isMicrophoneEnabled}
            isLocal={item.identity === localParticipant.identity}
            channelId={channelId}
          />
        )}
        ListEmptyComponent={
          <Text className="py-8 text-center text-sm text-text-muted">
            No other participants
          </Text>
        }
      />

      {/* Controls */}
      <View className="border-t border-border bg-bg-surface px-4 pb-8 pt-4">
        <View className="flex-row items-center justify-center gap-4">
          {/* Mute toggle */}
          <Pressable
            onPress={toggleMute}
            className={`h-14 w-14 items-center justify-center rounded-full ${
              isMicEnabled ? 'bg-bg-elevated' : 'bg-error/20'
            }`}
          >
            <Text className="text-xl">
              {isMicEnabled ? '🎤' : '🔇'}
            </Text>
          </Pressable>

          {/* Disconnect */}
          <Pressable
            onPress={disconnect}
            className="h-14 w-14 items-center justify-center rounded-full bg-error"
          >
            <Text className="text-xl">📞</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function ParticipantRow({
  identity,
  isMuted,
  isLocal,
  channelId,
}: {
  identity: string;
  isMuted: boolean;
  isLocal: boolean;
  channelId: string;
}) {
  const profile = useUsersStore((s) => s.profiles[identity]);
  const displayName =
    profile?.displayName || profile?.username || identity.slice(0, 8);

  return (
    <View className="mb-2 flex-row items-center rounded-lg bg-bg-surface px-4 py-3">
      {/* Avatar placeholder */}
      <View className="mr-3 h-10 w-10 items-center justify-center rounded-full bg-bg-elevated">
        <Text className="text-base font-medium text-text">
          {displayName[0]?.toUpperCase() ?? '?'}
        </Text>
      </View>

      {/* Name */}
      <View className="flex-1">
        <Text className={`text-sm ${isMuted ? 'text-text-muted' : 'text-text'}`}>
          {displayName}
          {isLocal && (
            <Text className="text-text-muted"> (you)</Text>
          )}
        </Text>
      </View>

      {/* Mute indicator */}
      {isMuted && (
        <Text className="text-xs text-text-muted">🔇</Text>
      )}
    </View>
  );
}
