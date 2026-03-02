/**
 * Hook for channel E2EE via static channel keys (mobile).
 *
 * Simplified port of packages/ui's useChannelEncryption.
 * Provides an async encrypt function once the channel key is available.
 * Decryption is handled by the gateway (real-time) and post-fetch decrypt
 * in the channel view (historical messages).
 */

import {
  bootstrapSession,
  type EncryptedMessage,
  encryptMessage,
  fetchAndCacheChannelKeys,
  hasChannelKey,
  isSessionReady,
  lazyInitChannelKey,
  onSessionReady,
  useAuthStore,
} from '@meza/core';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface ChannelEncryption {
  ready: boolean;
  encrypt: (plaintext: Uint8Array) => Promise<EncryptedMessage | null>;
  isEncrypted: boolean;
  retry: () => void;
}

const KEY_RETRY_DELAYS_MS = [500, 1_000, 1_500, 2_000];
const RETRY_COOLDOWN_MS = 10_000;

export function useChannelEncryption(channelId: string): ChannelEncryption {
  const [ready, setReady] = useState(false);
  const [isEncrypted, setIsEncrypted] = useState(false);
  const [sessionReady, setSessionReady] = useState(isSessionReady);
  const [retryCounter, setRetryCounter] = useState(0);
  const lastRetryRef = useRef(0);

  const readyRef = useRef(ready);
  const isEncryptedRef = useRef(isEncrypted);
  useEffect(() => {
    readyRef.current = ready;
  }, [ready]);
  useEffect(() => {
    isEncryptedRef.current = isEncrypted;
  }, [isEncrypted]);

  // Subscribe to E2EE session readiness
  useEffect(() => {
    if (sessionReady) return;

    const unsub = onSessionReady(() => setSessionReady(true));

    let cancelled = false;
    bootstrapSession().then((ok) => {
      if (cancelled) return;
      if (!ok) setReady(true);
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [sessionReady]);

  // Fetch and cache channel keys when session is ready
  useEffect(() => {
    if (!channelId) return;

    setReady(false);
    setIsEncrypted(false);

    if (!sessionReady) return;

    let cancelled = false;

    async function tryFetchKeys(): Promise<boolean> {
      if (hasChannelKey(channelId)) return true;
      try {
        await fetchAndCacheChannelKeys(channelId);
      } catch (err) {
        console.error(`[E2EE] fetchAndCacheChannelKeys failed for ${channelId}:`, err);
      }
      return hasChannelKey(channelId);
    }

    async function init() {
      if (await tryFetchKeys()) {
        if (!cancelled) {
          setIsEncrypted(true);
          setReady(true);
        }
        return;
      }

      // Attempt lazy key creation
      if (cancelled) return;
      const userId = useAuthStore.getState().user?.id;
      if (userId) {
        try {
          const ok = await lazyInitChannelKey(channelId, userId);
          if (!cancelled && ok) {
            setIsEncrypted(true);
            setReady(true);
            return;
          }
        } catch (err) {
          console.error(`[E2EE] lazyInitChannelKey failed for ${channelId}:`, err);
        }
      }

      // Retry with backoff (another client may be distributing keys)
      for (const delay of KEY_RETRY_DELAYS_MS) {
        if (cancelled) return;
        await new Promise((r) => setTimeout(r, delay));
        if (cancelled) return;
        if (await tryFetchKeys()) {
          if (!cancelled) {
            setIsEncrypted(true);
            setReady(true);
          }
          return;
        }
      }

      if (!cancelled) setReady(true);
    }

    init();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, sessionReady, retryCounter]);

  const retry = useCallback(() => {
    const now = Date.now();
    if (now - lastRetryRef.current < RETRY_COOLDOWN_MS) return;
    lastRetryRef.current = now;
    setRetryCounter((c) => c + 1);
  }, []);

  const encrypt = useCallback(
    async (plaintext: Uint8Array): Promise<EncryptedMessage | null> => {
      if (!readyRef.current || !isEncryptedRef.current) return null;
      try {
        return await encryptMessage(channelId, plaintext);
      } catch (err) {
        console.error(`[E2EE] encrypt failed for ${channelId}:`, err);
        return null;
      }
    },
    [channelId],
  );

  return { ready, encrypt, isEncrypted, retry };
}
