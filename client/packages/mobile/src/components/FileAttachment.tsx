import { getMediaURL } from '@meza/core';
import { Linking, Pressable, Text, View } from 'react-native';

interface FileAttachmentProps {
  attachmentId: string;
  filename: string;
  contentType: string;
  sizeBytes: bigint;
}

function formatFileSize(bytes: bigint): string {
  const num = Number(bytes);
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  return `${(num / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileAttachment({
  attachmentId,
  filename,
  contentType,
  sizeBytes,
}: FileAttachmentProps) {
  const url = getMediaURL(attachmentId);

  return (
    <Pressable
      onPress={() => Linking.openURL(url).catch(() => {})}
      className="mt-1 flex-row items-center rounded-lg border border-border bg-bg-surface px-3 py-2"
    >
      <View className="mr-3 h-8 w-8 items-center justify-center rounded bg-accent/20">
        <Text className="text-xs text-accent">
          {getFileIcon(contentType)}
        </Text>
      </View>
      <View className="flex-1">
        <Text className="text-sm text-text" numberOfLines={1}>
          {filename}
        </Text>
        <Text className="text-xs text-text-muted">
          {formatFileSize(sizeBytes)}
        </Text>
      </View>
    </Pressable>
  );
}

function getFileIcon(contentType: string): string {
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.includes('pdf')) return 'PDF';
  if (contentType.includes('zip') || contentType.includes('tar')) return 'ZIP';
  return 'FILE';
}
