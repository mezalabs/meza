import {
  ackMessage,
  decryptAndUpdateMessage,
  fetchAndCacheChannelKeys,
  getMessages,
  getPublicKeys,
  hasChannelKey,
  isSessionReady,
  safeParseMessageText,
  useAuthStore,
  useChannelStore,
  useGatewayStore,
  useMessageStore,
} from '@meza/core';
import type { Message } from '@meza/gen/meza/v1/models_pb.ts';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  Text,
  View,
} from 'react-native';
import { FileAttachment } from '@/components/FileAttachment';
import { ImageAttachment } from '@/components/ImageAttachment';
import { MessageComposer } from '@/components/MessageComposer';
import { TypingIndicator } from '@/components/TypingIndicator';

export default function ChannelScreen() {
  const { channelId } = useLocalSearchParams<{ channelId: string }>();
  const router = useRouter();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const reconnectCount = useGatewayStore((s) => s.reconnectCount);
  const messages = useMessageStore(
    (s) => s.byChannel[channelId ?? ''] ?? EMPTY_MESSAGES,
  );
  const isLoading = useMessageStore(
    (s) => s.isLoading[channelId ?? ''] ?? false,
  );
  const hasMore = useMessageStore(
    (s) => s.hasMore[channelId ?? ''] ?? true,
  );
  const channelName = useChannelStore((s) => {
    const serverId = s.channelToServer[channelId ?? ''];
    if (!serverId) return '';
    const channels = s.byServer[serverId] ?? [];
    const ch = channels.find((c) => c.id === channelId);
    return ch?.name ?? '';
  });

  // Register/unregister viewed channel for unread suppression
  useEffect(() => {
    if (!channelId) return;
    useGatewayStore.getState().addViewedChannel(channelId);
    return () => useGatewayStore.getState().removeViewedChannel(channelId);
  }, [channelId]);

  // Fetch messages + decrypt on mount and reconnect
  useEffect(() => {
    if (!channelId || !isAuthenticated) return;
    let ignore = false;

    (async () => {
      try {
        const res = await getMessages(channelId);
        if (ignore || !res?.messages?.length) return;

        // Ack the latest message for read receipts
        const latest = res.messages[res.messages.length - 1];
        if (latest) {
          ackMessage(channelId, latest.id).catch(() => {});
        }

        // Fetch channel keys if needed
        if (isSessionReady() && !hasChannelKey(channelId)) {
          try {
            await fetchAndCacheChannelKeys(channelId);
          } catch {}
        }

        // Decrypt messages with keyVersion > 0
        if (isSessionReady() && hasChannelKey(channelId)) {
          const encrypted = res.messages.filter(
            (m: { keyVersion: number }) => m.keyVersion > 0,
          );
          if (encrypted.length === 0) return;

          const authorIds = [
            ...new Set(encrypted.map((m: { authorId: string }) => m.authorId)),
          ];
          let pubKeys: Record<string, Uint8Array> = {};
          try {
            pubKeys = await getPublicKeys(authorIds);
          } catch {}

          // Decrypt newest first so bottom of chat resolves first
          for (const msg of [...encrypted].reverse()) {
            if (ignore) break;
            const pk = pubKeys[msg.authorId];
            if (!pk) continue;
            try {
              await decryptAndUpdateMessage(channelId, msg, pk);
            } catch {}
          }
        }
      } catch (err) {
        console.error('[channel] getMessages failed:', err);
      }
    })();

    return () => {
      ignore = true;
    };
  }, [channelId, isAuthenticated, reconnectCount]);

  // Load more messages (scroll up pagination)
  const loadMore = useCallback(() => {
    if (!channelId || !hasMore || isLoading) return;
    const oldest = messages[0];
    if (!oldest) return;
    getMessages(channelId, { before: oldest.id }).catch(() => {});
  }, [channelId, hasMore, isLoading, messages]);

  const renderMessage = useCallback(
    ({ item: msg }: { item: Message }) => {
      const isStillEncrypted = msg.keyVersion > 0;
      const text =
        !isStillEncrypted && msg.encryptedContent.length > 0
          ? safeParseMessageText(msg.encryptedContent)
          : '';
      const isOwn = msg.authorId === currentUserId;

      const time = msg.createdAt
        ? new Date(
            Number(msg.createdAt.seconds) * 1000,
          ).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '';

      return (
        <View className={`px-4 py-1 ${isOwn ? 'items-end' : 'items-start'}`}>
          <View
            className={`max-w-[80%] rounded-2xl px-3.5 py-2 ${
              isOwn
                ? 'rounded-br-sm bg-accent'
                : 'rounded-bl-sm bg-bg-surface'
            }`}
          >
            {!isOwn && (
              <Text className="mb-0.5 text-xs font-semibold text-accent">
                {msg.authorId.slice(0, 8)}
              </Text>
            )}
            {isStillEncrypted ? (
              <Text className="text-sm italic text-text-muted">
                Decrypting...
              </Text>
            ) : (
              <>
                {text ? (
                  <Text
                    className={`text-sm ${isOwn ? 'text-black' : 'text-text'}`}
                  >
                    {text}
                  </Text>
                ) : null}
                {msg.attachments.map((att) =>
                  att.contentType.startsWith('image/') ? (
                    <ImageAttachment
                      key={att.id}
                      attachmentId={att.id}
                      width={att.width}
                      height={att.height}
                      filename={att.filename}
                      hasThumbnail={att.hasThumbnail}
                    />
                  ) : (
                    <FileAttachment
                      key={att.id}
                      attachmentId={att.id}
                      filename={att.filename}
                      contentType={att.contentType}
                      sizeBytes={att.sizeBytes}
                    />
                  ),
                )}
              </>
            )}
            <Text
              className={`mt-0.5 text-[10px] ${
                isOwn ? 'text-black/50' : 'text-text-muted'
              }`}
            >
              {time}
              {msg.editedAt ? ' (edited)' : ''}
            </Text>
          </View>
        </View>
      );
    },
    [currentUserId],
  );

  return (
    <View className="flex-1 bg-bg-base">
      {/* Header */}
      <View className="flex-row items-center border-b border-border bg-bg-surface px-4 pb-3 pt-14">
        <Pressable onPress={() => router.back()} className="mr-3 p-1">
          <Text className="text-lg text-accent">&lt;</Text>
        </Pressable>
        <Text className="flex-1 text-lg font-semibold text-text">
          # {channelName || channelId}
        </Text>
      </View>

      {/* Messages */}
      <FlatList
        data={messages}
        keyExtractor={keyExtractor}
        renderItem={renderMessage}
        inverted
        contentContainerStyle={{ paddingVertical: 8 }}
        onEndReached={loadMore}
        onEndReachedThreshold={0.3}
        ListFooterComponent={
          isLoading ? (
            <View className="items-center py-4">
              <ActivityIndicator size="small" color="#888" />
            </View>
          ) : null
        }
        ListEmptyComponent={
          !isLoading ? (
            <View className="flex-1 items-center justify-center py-8">
              <Text className="text-sm text-text-muted">
                No messages yet. Start the conversation!
              </Text>
            </View>
          ) : null
        }
      />

      <TypingIndicator channelId={channelId ?? ''} />
      <MessageComposer channelId={channelId ?? ''} />
    </View>
  );
}

const EMPTY_MESSAGES: Message[] = [];

function keyExtractor(msg: Message) {
  return msg.id;
}
