import {
  type Channel,
  ChannelType,
  type Server,
  useChannelStore,
  useServerStore,
} from '@meza/core';
import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import {
  FlatList,
  Pressable,
  Text,
  View,
} from 'react-native';

interface ChannelGroup {
  server: Server;
  channels: Channel[];
}

export default function ChannelListScreen() {
  const router = useRouter();
  const servers = useServerStore((s) => s.servers);
  const byServer = useChannelStore((s) => s.byServer);

  const groups = useMemo(() => {
    const result: ChannelGroup[] = [];
    for (const server of Object.values(servers)) {
      const channels = byServer[server.id] ?? [];
      if (channels.length > 0) {
        result.push({ server, channels });
      }
    }
    return result;
  }, [servers, byServer]);

  type ListItem =
    | { type: 'header'; server: Server }
    | { type: 'channel'; channel: Channel };

  const flatData = useMemo(() => {
    const items: ListItem[] = [];
    for (const group of groups) {
      items.push({ type: 'header', server: group.server });
      for (const channel of group.channels) {
        items.push({ type: 'channel', channel });
      }
    }
    return items;
  }, [groups]);

  function getItemKey(item: ListItem) {
    return item.type === 'header' ? `srv-${item.server.id}` : `ch-${item.channel.id}`;
  }

  return (
    <View className="flex-1 bg-bg-base">
      <View className="border-b border-border bg-bg-surface px-4 pb-3 pt-14">
        <Text className="text-xl font-bold text-text">Channels</Text>
      </View>

      {flatData.length === 0 ? (
        <View className="flex-1 items-center justify-center">
          <Text className="text-sm text-text-muted">No channels yet</Text>
        </View>
      ) : (
        <FlatList
          data={flatData}
          keyExtractor={getItemKey}
          renderItem={({ item }) => {
            if (item.type === 'header') {
              return (
                <View className="bg-bg-base px-4 pb-1 pt-4">
                  <Text className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                    {item.server.name}
                  </Text>
                </View>
              );
            }
            return (
              <Pressable
                onPress={() =>
                  router.push(`/(app)/(channels)/${item.channel.id}`)
                }
                className="mx-2 rounded-lg px-3 py-2.5 active:bg-bg-surface"
              >
                <Text className="text-sm text-text">
                  {item.channel.type === ChannelType.VOICE ? '🔊 ' : '# '}
                  {item.channel.name}
                </Text>
                {item.channel.topic ? (
                  <Text
                    className="mt-0.5 text-xs text-text-muted"
                    numberOfLines={1}
                  >
                    {item.channel.topic}
                  </Text>
                ) : null}
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}
