import {
  buildMessageContent,
  gatewaySendTyping,
  sendMessage,
} from '@meza/core';
import { useCallback, useRef, useState } from 'react';
import {
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useChannelEncryption } from '@/hooks/useChannelEncryption';

interface MessageComposerProps {
  channelId: string;
}

export function MessageComposer({ channelId }: MessageComposerProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const { ready, encrypt, isEncrypted } = useChannelEncryption(channelId);
  const lastTypingRef = useRef(0);

  const handleTextChange = useCallback(
    (value: string) => {
      setText(value);

      // Throttle typing indicator to once per 3 seconds
      const now = Date.now();
      if (now - lastTypingRef.current > 3000) {
        lastTypingRef.current = now;
        gatewaySendTyping(channelId);
      }
    },
    [channelId],
  );

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    setSending(true);
    try {
      const plaintext = buildMessageContent(trimmed);

      if (isEncrypted) {
        const encrypted = await encrypt(plaintext);
        if (encrypted) {
          await sendMessage({
            channelId,
            encryptedContent: encrypted.data,
            keyVersion: encrypted.keyVersion,
            nonce: '',
            plaintext,
          });
        }
      } else {
        // Unencrypted fallback (shouldn't happen with universal E2EE)
        await sendMessage({
          channelId,
          encryptedContent: plaintext,
          keyVersion: 0,
          nonce: '',
          plaintext,
        });
      }

      setText('');
    } catch (err) {
      console.error('[composer] send failed:', err);
    } finally {
      setSending(false);
    }
  }, [text, sending, channelId, encrypt, isEncrypted]);

  const canSend = text.trim().length > 0 && ready && !sending;

  return (
    <View className="border-t border-border bg-bg-surface px-3 pb-6 pt-2">
      <View className="flex-row items-end rounded-xl bg-bg-base px-3">
        <TextInput
          className="max-h-24 min-h-[40px] flex-1 py-2.5 text-sm text-text"
          placeholder={
            !ready
              ? 'Initializing encryption...'
              : 'Send a message'
          }
          placeholderTextColor="#666"
          value={text}
          onChangeText={handleTextChange}
          multiline
          editable={ready}
          onSubmitEditing={handleSend}
          blurOnSubmit={false}
        />
        <Pressable
          onPress={handleSend}
          disabled={!canSend}
          className="mb-1.5 ml-2 items-center justify-center rounded-full bg-accent px-3 py-1.5 disabled:opacity-30"
        >
          <Text className="text-xs font-semibold text-black">
            {sending ? '...' : 'Send'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
