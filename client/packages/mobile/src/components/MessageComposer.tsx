import {
  buildMessageContent,
  gatewaySendTyping,
  sendMessage,
  type UploadedFile,
} from '@meza/core';
import { useCallback, useRef, useState } from 'react';
import {
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useChannelEncryption } from '@/hooks/useChannelEncryption';
import { pickImage, pickDocument, uploadEncryptedFileMobile, type PickedFile } from '@/lib/media';

interface MessageComposerProps {
  channelId: string;
}

export function MessageComposer({ channelId }: MessageComposerProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [pendingFile, setPendingFile] = useState<PickedFile | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
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

  const handlePickImage = useCallback(async () => {
    const file = await pickImage('library');
    if (file) setPendingFile(file);
  }, []);

  const handlePickDocument = useCallback(async () => {
    const file = await pickDocument();
    if (file) setPendingFile(file);
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if ((!trimmed && !pendingFile) || sending) return;

    setSending(true);
    try {
      // Upload file attachment if present
      let uploadedFiles: UploadedFile[] = [];

      if (pendingFile) {
        const result = await uploadEncryptedFileMobile(
          pendingFile,
          channelId,
          setUploadProgress,
        );
        uploadedFiles = [
          {
            attachmentId: result.attachmentId,
            filename: result.filename,
            contentType: result.contentType,
            sizeBytes: result.sizeBytes,
            microThumbnail: result.microThumbnail,
            url: '',
            hasThumbnail: false,
            width: result.width,
            height: result.height,
          },
        ];
      }

      // Build attachment metadata map for message content JSON
      const attachmentMeta =
        uploadedFiles.length > 0
          ? new Map(
              uploadedFiles.map((f) => [
                f.attachmentId,
                {
                  microThumb: f.microThumbnail,
                  filename: f.filename,
                  contentType: f.contentType,
                },
              ]),
            )
          : undefined;

      const plaintext = buildMessageContent(trimmed || '', attachmentMeta);

      if (isEncrypted) {
        const encrypted = await encrypt(plaintext);
        if (encrypted) {
          await sendMessage({
            channelId,
            encryptedContent: encrypted.data,
            keyVersion: encrypted.keyVersion,
            nonce: '',
            plaintext,
            uploadedFiles,
          });
        }
      } else {
        await sendMessage({
          channelId,
          encryptedContent: plaintext,
          keyVersion: 0,
          nonce: '',
          plaintext,
          uploadedFiles,
        });
      }

      setText('');
      setPendingFile(null);
      setUploadProgress(0);
    } catch (err) {
      console.error('[composer] send failed:', err);
    } finally {
      setSending(false);
    }
  }, [text, pendingFile, sending, channelId, encrypt, isEncrypted]);

  const canSend = (text.trim().length > 0 || pendingFile) && ready && !sending;

  return (
    <View className="border-t border-border bg-bg-surface px-3 pb-6 pt-2">
      {/* Pending file preview */}
      {pendingFile && (
        <View className="mb-2 flex-row items-center rounded-lg bg-bg-base px-3 py-2">
          <Text className="flex-1 text-xs text-text" numberOfLines={1}>
            {pendingFile.name}
          </Text>
          {sending && uploadProgress > 0 && (
            <Text className="mr-2 text-xs text-text-muted">
              {uploadProgress}%
            </Text>
          )}
          <Pressable onPress={() => setPendingFile(null)} disabled={sending}>
            <Text className="text-xs text-error">Remove</Text>
          </Pressable>
        </View>
      )}

      <View className="flex-row items-end rounded-xl bg-bg-base px-3">
        {/* Attachment button */}
        <Pressable
          onPress={handlePickImage}
          onLongPress={handlePickDocument}
          className="mb-2 mr-1 p-1"
          disabled={sending}
        >
          <Text className="text-lg text-text-muted">+</Text>
        </Pressable>

        <TextInput
          className="max-h-24 min-h-[40px] flex-1 py-2.5 text-sm text-text"
          placeholder={
            !ready ? 'Initializing encryption...' : 'Send a message'
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
