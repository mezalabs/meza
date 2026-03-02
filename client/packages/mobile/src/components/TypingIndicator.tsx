import { useAuthStore, useTypingStore, useUsersStore } from '@meza/core';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

interface TypingIndicatorProps {
  channelId: string;
}

export function TypingIndicator({ channelId }: TypingIndicatorProps) {
  const currentUserId = useAuthStore((s) => s.user?.id);
  const typingUsers = useTypingStore((s) => s.byChannel[channelId]);
  const profiles = useUsersStore((s) => s.profiles);
  const [dots, setDots] = useState('');

  // Animate dots
  useEffect(() => {
    if (!typingUsers) return;
    const now = Date.now();
    const activeIds = Object.entries(typingUsers)
      .filter(([uid, exp]) => uid !== currentUserId && exp > now)
      .map(([uid]) => uid);
    if (activeIds.length === 0) return;

    const interval = setInterval(() => {
      setDots((d) => (d.length >= 3 ? '' : d + '.'));
    }, 500);
    return () => clearInterval(interval);
  }, [typingUsers, currentUserId]);

  if (!typingUsers) return null;

  const now = Date.now();
  const activeIds = Object.entries(typingUsers)
    .filter(([uid, exp]) => uid !== currentUserId && exp > now)
    .map(([uid]) => uid);

  if (activeIds.length === 0) return null;

  const names = activeIds
    .map((uid) => {
      const profile = profiles[uid];
      return profile?.displayName || profile?.username || 'Someone';
    })
    .slice(0, 3);

  let text: string;
  if (names.length === 1) {
    text = `${names[0]} is typing`;
  } else if (names.length === 2) {
    text = `${names[0]} and ${names[1]} are typing`;
  } else {
    text = 'Several people are typing';
  }

  return (
    <View className="px-4 py-1">
      <Text className="text-xs text-text-muted">
        {text}
        {dots}
      </Text>
    </View>
  );
}
