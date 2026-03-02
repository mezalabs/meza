import {
  type DMChannel,
  getDMDisplayName,
  useAuthStore,
  useDMStore,
} from '@meza/core';
import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import {
  FlatList,
  Pressable,
  Text,
  View,
} from 'react-native';

export default function DMListScreen() {
  const router = useRouter();
  const currentUserId = useAuthStore((s) => s.user?.id) ?? '';
  const dmChannels = useDMStore((s) => s.dmChannels);
  const messageRequests = useDMStore((s) => s.messageRequests);

  const renderDM = useCallback(
    ({ item: dm }: { item: DMChannel }) => {
      const channelId = dm.channel?.id;
      if (!channelId) return null;
      const displayName = getDMDisplayName(dm, currentUserId);

      return (
        <Pressable
          onPress={() => router.push(`/(app)/(dms)/${channelId}`)}
          className="mx-2 flex-row items-center rounded-lg px-3 py-3 active:bg-bg-surface"
        >
          {/* Avatar placeholder */}
          <View className="mr-3 h-10 w-10 items-center justify-center rounded-full bg-bg-surface">
            <Text className="text-sm font-semibold text-text-muted">
              {displayName.charAt(0).toUpperCase()}
            </Text>
          </View>
          <View className="flex-1">
            <Text className="text-sm font-medium text-text" numberOfLines={1}>
              {displayName}
            </Text>
            <Text className="mt-0.5 text-xs text-text-muted" numberOfLines={1}>
              {dm.participants.length > 2
                ? `${dm.participants.length} members`
                : 'Direct message'}
            </Text>
          </View>
        </Pressable>
      );
    },
    [currentUserId, router],
  );

  return (
    <View className="flex-1 bg-bg-base">
      <View className="border-b border-border bg-bg-surface px-4 pb-3 pt-14">
        <Text className="text-xl font-bold text-text">Messages</Text>
      </View>

      {messageRequests.length > 0 && (
        <Pressable className="mx-4 mt-3 rounded-lg border border-border bg-bg-surface px-4 py-3">
          <Text className="text-sm text-text">
            Message Requests ({messageRequests.length})
          </Text>
        </Pressable>
      )}

      {dmChannels.length === 0 ? (
        <View className="flex-1 items-center justify-center">
          <Text className="text-sm text-text-muted">No conversations yet</Text>
        </View>
      ) : (
        <FlatList
          data={dmChannels}
          keyExtractor={dmKeyExtractor}
          renderItem={renderDM}
          contentContainerStyle={{ paddingTop: 4 }}
        />
      )}
    </View>
  );
}

function dmKeyExtractor(dm: DMChannel) {
  return dm.channel?.id ?? '';
}
