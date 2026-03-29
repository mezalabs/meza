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
  requestChannelKeys,
  useAuthStore,
} from '@meza/core';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Why encryption is unavailable — helps the UI show actionable guidance. */
export type EncryptionUnavailableReason =
  | 'no-session'
  | 'no-channel-key'
  | null;

export interface ChannelEncryption {
  /** Whether the channel key is ready for encryption. */
  ready: boolean;
  /** Encrypt plaintext for this channel. Returns EncryptedMessage or null. */
  encrypt: (plaintext: Uint8Array) => Promise<EncryptedMessage | null>;
  /** Whether this channel uses E2EE (always true with universal encryption). */
  isEncrypted: boolean;
  /** Manually retry key initialization (e.g. after timeout). */
  retry: () => void;
  /** Why encryption is unavailable (null when encrypted or still loading). */
  unavailableReason: EncryptionUnavailableReason;
}

/** Retry delays used only after lazy init fails (another client won the
 *  key-creation race and is distributing — we wait for their keys).
 *  Increased from [1000, 2000] to give more time for large-server
 *  key distribution while keeping total wait under 5s. */
const KEY_RETRY_DELAYS_MS = [500, 1_000, 1_500, 2_000];

/** Slow poll interval after fast retries are exhausted. Keeps checking for
 *  keys that may arrive via reconnect-triggered redistribution. */
const SLOW_POLL_MS = 10_000;

/** Maximum number of slow polls before giving up (10s * 30 = 5 minutes). */
const MAX_SLOW_POLLS = 30;

/** Minimum interval between manual retries to prevent rapid clicking. */
const RETRY_COOLDOWN_MS = 3_000;

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
  const [unavailableReason, setUnavailableReason] =
    useState<EncryptionUnavailableReason>(null);
  // Incrementing this counter re-runs the init effect (manual retry).
  const [retryCounter, setRetryCounter] = useState(0);
  const lastRetryRef = useRef(0);

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
        // Mark ready so the composer isn't blocked, but record why.
        setUnavailableReason('no-session');
        setReady(true);
      }
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [sessionReady]);

  // Fetch and cache channel keys when session is ready
  // biome-ignore lint/correctness/useExhaustiveDependencies: retryCounter is an intentional re-trigger for manual retry
  useEffect(() => {
    if (!channelId) return;

    // If keys are already cached in memory, resolve synchronously to avoid
    // an unnecessary "Setting up encryption" flash on channel switch.
    if (sessionReady && hasChannelKey(channelId)) {
      setReady(true);
      setIsEncrypted(true);
      setUnavailableReason(null);
      return;
    }

    setReady(false);
    setIsEncrypted(false);
    setUnavailableReason(null);

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

      // Fast retries exhausted — actively request keys from online members
      // and start slow poll. Cap at 5 minutes.
      try {
        await requestChannelKeys(channelId);
      } catch {
        // Best-effort — don't break the poll loop.
      }
      if (!cancelled) {
        setUnavailableReason('no-channel-key');
        setReady(true);
      }
      for (let poll = 0; poll < MAX_SLOW_POLLS && !cancelled; poll++) {
        await new Promise((r) => setTimeout(r, SLOW_POLL_MS));
        if (cancelled) return;
        if (await tryFetchKeys()) {
          if (!cancelled) {
            setUnavailableReason(null);
            setIsEncrypted(true);
            setReady(true);
          }
          return;
        }
        // Re-request every ~60s (every 6th poll) in case earlier requests
        // didn't reach anyone online.
        if (poll > 0 && poll % 6 === 0) {
          try {
            await requestChannelKeys(channelId);
          } catch {
            // Best-effort.
          }
        }
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, [channelId, sessionReady, retryCounter]);

  // Manual retry with cooldown to prevent rapid clicking
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

  return { ready, encrypt, isEncrypted, retry, unavailableReason };
}
