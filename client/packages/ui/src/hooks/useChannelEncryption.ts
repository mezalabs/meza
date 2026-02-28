/**
 * Hook for channel E2EE via static channel keys.
 *
 * All channels use E2EE (universal encryption). Provides an async encrypt
 * function once the channel key is available.
 *
 * Decryption is handled by the gateway (real-time messages) and by
 * post-fetch decrypt in ChannelView (historical messages).
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
  /** Whether the channel key is ready for encryption. */
  ready: boolean;
  /** Encrypt plaintext for this channel. Returns EncryptedMessage or null. */
  encrypt: (plaintext: Uint8Array) => Promise<EncryptedMessage | null>;
  /** Whether this channel uses E2EE (always true with universal encryption). */
  isEncrypted: boolean;
}

/** Retry delays used only after lazy init fails (another client won the
 *  key-creation race and is distributing — we wait for their keys). */
const KEY_RETRY_DELAYS_MS = [1_000, 2_000];

/**
 * Manages channel key state for an encrypted channel.
 * Returns an encrypt function once the channel key is available.
 *
 * @param channelId - The channel ID
 */
export function useChannelEncryption(channelId: string): ChannelEncryption {
  const [ready, setReady] = useState(false);
  const [isEncrypted, setIsEncrypted] = useState(false);
  const [sessionReady, setSessionReady] = useState(isSessionReady);

  // Keep refs in sync so the encrypt callback always reads current values
  // (avoids stale closure when state transitions between render and action).
  const readyRef = useRef(ready);
  const isEncryptedRef = useRef(isEncrypted);
  useEffect(() => {
    readyRef.current = ready;
  }, [ready]);
  useEffect(() => {
    isEncryptedRef.current = isEncrypted;
  }, [isEncrypted]);

  // Subscribe to E2EE session readiness, with an active bootstrap attempt
  // so we don't stay stuck if the session was never kicked off.
  useEffect(() => {
    if (sessionReady) return;

    const unsub = onSessionReady(() => setSessionReady(true));

    // Attempt bootstrap (no-op if already bootstrapped or in progress).
    // If it returns false (no master key), the session will never be ready
    // for this page load — mark ready so the composer isn't blocked.
    let cancelled = false;
    bootstrapSession().then((ok) => {
      if (cancelled) return;
      if (!ok) {
        // Session can't bootstrap (no master key in sessionStorage).
        // Allow sending without encryption rather than blocking forever.
        setReady(true);
      }
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
        console.error(
          `[E2EE] fetchAndCacheChannelKeys failed for ${channelId}:`,
          err,
        );
      }
      return hasChannelKey(channelId);
    }

    async function init() {
      // First attempt — keys may already be cached or on the server.
      if (await tryFetchKeys()) {
        if (!cancelled) {
          setIsEncrypted(true);
          setReady(true);
        }
        return;
      }

      // No keys on first fetch — immediately attempt lazy key creation
      // for channels that never had a key provisioned (e.g., pre-existing
      // public channels before universal E2EE). This avoids a multi-second
      // retry waterfall for the common cold-start case.
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
          console.error(
            `[E2EE] lazyInitChannelKey failed for ${channelId}:`,
            err,
          );
        }
      }

      // Lazy init failed — another client may have won the key-creation
      // race and is now distributing keys to us. Retry fetch with backoff
      // to wait for their wrapped key to arrive.
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

      // Truly no keys available — mark ready so composer shows unavailable state
      if (!cancelled) setReady(true);
    }

    init();
    return () => {
      cancelled = true;
    };
  }, [channelId, sessionReady]);

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

  return { ready, encrypt, isEncrypted };
}
