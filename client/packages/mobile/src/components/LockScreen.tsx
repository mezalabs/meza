import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  authenticateAndUnlock,
  getIsLocked,
  onLockStateChange,
} from '@/lib/biometric-lock';

export function LockScreen() {
  const [locked, setLocked] = useState(getIsLocked);
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);

  useEffect(() => {
    const unsub = onLockStateChange(setLocked);
    return unsub;
  }, []);

  // Auto-prompt on mount if locked
  useEffect(() => {
    if (locked && attempts === 0) {
      handleUnlock();
    }
  }, [locked]);

  async function handleUnlock() {
    setError(null);
    const key = await authenticateAndUnlock();
    if (!key) {
      setAttempts((a) => a + 1);
      setError(
        attempts >= 2
          ? 'Biometric authentication failed. Please log in again.'
          : 'Authentication failed. Try again.',
      );
    }
  }

  if (!locked) return null;

  return (
    <View className="absolute inset-0 z-50 items-center justify-center bg-bg-base">
      <Text className="mb-2 text-2xl font-bold text-text">Meza</Text>
      <Text className="mb-8 text-sm text-text-muted">Locked</Text>

      {error && (
        <View className="mb-4 rounded-lg bg-error/10 px-4 py-3">
          <Text className="text-xs text-error">{error}</Text>
        </View>
      )}

      <Pressable
        onPress={handleUnlock}
        className="rounded-lg bg-accent px-8 py-3 active:bg-accent-hover"
      >
        <Text className="text-sm font-medium text-black">Unlock</Text>
      </Pressable>
    </View>
  );
}
