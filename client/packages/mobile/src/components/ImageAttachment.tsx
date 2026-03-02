import { getMediaURL } from '@meza/core';
import { useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  Text,
  View,
} from 'react-native';

interface ImageAttachmentProps {
  attachmentId: string;
  width: number;
  height: number;
  filename: string;
  hasThumbnail: boolean;
}

const MAX_WIDTH = 250;
const MAX_HEIGHT = 300;

export function ImageAttachment({
  attachmentId,
  width,
  height,
  filename,
  hasThumbnail,
}: ImageAttachmentProps) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  // Calculate display dimensions (fit within max bounds)
  const aspect = width && height ? width / height : 1;
  let displayWidth = Math.min(width || MAX_WIDTH, MAX_WIDTH);
  let displayHeight = displayWidth / aspect;
  if (displayHeight > MAX_HEIGHT) {
    displayHeight = MAX_HEIGHT;
    displayWidth = displayHeight * aspect;
  }

  // Use the media redirect URL (includes auth token)
  const thumbnailUrl = hasThumbnail
    ? getMediaURL(attachmentId, true)
    : getMediaURL(attachmentId);
  const fullUrl = getMediaURL(attachmentId);

  return (
    <>
      <Pressable onPress={() => setViewerOpen(true)} className="mt-1">
        <View
          style={{ width: displayWidth, height: displayHeight }}
          className="overflow-hidden rounded-lg bg-bg-surface"
        >
          {loading && (
            <View className="absolute inset-0 items-center justify-center">
              <ActivityIndicator size="small" color="#888" />
            </View>
          )}
          <Image
            source={{ uri: thumbnailUrl }}
            style={{ width: displayWidth, height: displayHeight }}
            resizeMode="cover"
            onLoadEnd={() => setLoading(false)}
          />
        </View>
      </Pressable>

      {/* Full-screen image viewer */}
      <Modal
        visible={viewerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setViewerOpen(false)}
      >
        <Pressable
          onPress={() => setViewerOpen(false)}
          className="flex-1 items-center justify-center bg-black/90"
        >
          <Image
            source={{ uri: fullUrl }}
            className="h-full w-full"
            resizeMode="contain"
          />
          <Text className="absolute bottom-16 text-xs text-white/60">
            {filename}
          </Text>
        </Pressable>
      </Modal>
    </>
  );
}
