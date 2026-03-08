/**
 * Federation satellite token refresh cascade.
 *
 * Handles proactive token refresh at 75% of TTL, dependency-aware cascade
 * (home must be reachable for satellite refreshes), and recovery after
 * home connection outages.
 */

import { FederationService } from '@meza/gen/meza/v1/federation_pb.ts';
import { createInstanceClient } from './client.ts';
import { useInstanceStore } from '../store/instances.ts';
import { useGatewayStore } from '../store/gateway.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function homeClient() {
  return createInstanceClient(FederationService);
}

function satelliteClient(instanceUrl: string) {
  return createInstanceClient(FederationService, instanceUrl);
}

// ---------------------------------------------------------------------------
// Refresh timer management
// ---------------------------------------------------------------------------

/** Scheduled proactive refresh timers, keyed by instance URL. */
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** When true, satellite refreshes are paused because the home is unreachable. */
let homePaused = false;

/** Instance URLs that need a refresh once home connectivity is restored. */
const pendingRefreshes = new Set<string>();

/**
 * Decode the `exp` and `iat` claims from a JWT access token without
 * validating the signature (we only need the TTL for scheduling).
 */
function decodeJwtTtlMs(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    // biome-ignore lint/style/noNonNullAssertion: length check above guarantees index 1
    const payload = JSON.parse(atob(parts[1]!));
    const exp = payload.exp as number | undefined;
    const iat = payload.iat as number | undefined;
    if (typeof exp !== 'number') return null;
    if (typeof iat === 'number') {
      return (exp - iat) * 1000;
    }
    // Fallback: compute from now
    const ttlMs = exp * 1000 - Date.now();
    return ttlMs > 0 ? ttlMs : null;
  } catch {
    return null;
  }
}

/**
 * Schedule a proactive refresh at ~75% of the access token TTL (with jitter).
 * Cancels any previously scheduled timer for the same instance.
 */
export function scheduleTokenRefresh(
  instanceUrl: string,
  accessToken: string,
): void {
  clearTokenRefreshTimer(instanceUrl);

  const ttlMs = decodeJwtTtlMs(accessToken);
  if (!ttlMs || ttlMs <= 0) return;

  // 75% of TTL + random jitter up to 10% of TTL
  const delay = ttlMs * 0.75 + Math.random() * 0.1 * ttlMs;

  const timer = setTimeout(() => {
    refreshTimers.delete(instanceUrl);
    refreshSatelliteToken(instanceUrl).catch((err) => {
      console.warn(
        `[Federation] proactive refresh failed for ${instanceUrl}:`,
        err,
      );
    });
  }, delay);

  refreshTimers.set(instanceUrl, timer);
}

/**
 * Cancel a pending proactive refresh timer for an instance.
 */
export function clearTokenRefreshTimer(instanceUrl: string): void {
  const existing = refreshTimers.get(instanceUrl);
  if (existing) {
    clearTimeout(existing);
    refreshTimers.delete(instanceUrl);
  }
}

/**
 * Cancel all proactive refresh timers.
 */
export function clearAllTokenRefreshTimers(): void {
  for (const timer of refreshTimers.values()) {
    clearTimeout(timer);
  }
  refreshTimers.clear();
  pendingRefreshes.clear();
}

// ---------------------------------------------------------------------------
// Core refresh logic
// ---------------------------------------------------------------------------

/** Per-instance dedup: prevents concurrent refreshes for the same satellite. */
const refreshInFlight = new Map<string, Promise<boolean>>();

/**
 * Refresh a satellite instance's tokens via the federation assertion flow.
 *
 * 1. Get current instance state
 * 2. Request assertion from the home server
 * 3. Exchange assertion + refresh token on the satellite
 * 4. Update tokens in the instance store
 * 5. Schedule the next proactive refresh
 *
 * Deduplicated: concurrent calls for the same instance share one in-flight
 * promise (prevents proactive timer + 401 interceptor racing).
 *
 * Returns true on success, false on failure.
 */
export async function refreshSatelliteToken(
  instanceUrl: string,
): Promise<boolean> {
  const existing = refreshInFlight.get(instanceUrl);
  if (existing) return existing;

  const promise = doRefreshSatelliteToken(instanceUrl).finally(() => {
    refreshInFlight.delete(instanceUrl);
  });
  refreshInFlight.set(instanceUrl, promise);
  return promise;
}

async function doRefreshSatelliteToken(
  instanceUrl: string,
): Promise<boolean> {
  const instance = useInstanceStore.getState().getInstance(instanceUrl);
  if (!instance || instance.status === 'error') return false;
  if (instance.status === 'connecting') return false;

  // If the home connection is down, defer the refresh
  const homeStatus = useGatewayStore.getState().status;
  if (homeStatus !== 'connected') {
    homePaused = true;
    pendingRefreshes.add(instanceUrl);
    return false;
  }

  try {
    // 1. Request assertion from the home server
    const assertionRes = await homeClient().createFederationAssertion({
      targetInstanceUrl: instanceUrl,
    });

    // 2. Refresh on satellite
    const refreshRes = await satelliteClient(instanceUrl).federationRefresh({
      assertionToken: assertionRes.assertionToken,
      refreshToken: instance.refreshToken,
    });

    // 3. Update tokens in instance store
    useInstanceStore.getState().updateInstanceTokens(
      instanceUrl,
      refreshRes.accessToken,
      refreshRes.refreshToken,
    );

    // 4. Schedule the next proactive refresh
    scheduleTokenRefresh(instanceUrl, refreshRes.accessToken);

    return true;
  } catch (err) {
    console.error(
      `[Federation] token refresh failed for ${instanceUrl}:`,
      err,
    );

    // If the home is unreachable (network error), pause satellite refreshes
    if (isNetworkError(err)) {
      homePaused = true;
      pendingRefreshes.add(instanceUrl);
    }

    return false;
  }
}

/**
 * Refresh all connected satellite instances in parallel.
 * Uses Promise.allSettled so one failure does not block others.
 */
export async function refreshAllSatelliteTokens(): Promise<void> {
  const instances = useInstanceStore.getState().instances;
  const urls = Object.keys(instances).filter((url) => {
    const inst = instances[url];
    return (
      inst &&
      (inst.status === 'connected' || inst.status === 'reconnecting')
    );
  });

  if (urls.length === 0) return;

  const results = await Promise.allSettled(
    urls.map((url) => refreshSatelliteToken(url)),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result && result.status === 'rejected') {
      console.warn(
        `[Federation] refresh failed for ${urls[i]}:`,
        result.reason,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Dependency-aware cascade: home recovery
// ---------------------------------------------------------------------------

/**
 * Called when the home connection recovers after an outage.
 * Resumes any paused satellite refreshes.
 */
export async function onHomeConnectionRecovered(): Promise<void> {
  if (!homePaused) return;
  homePaused = false;

  // Collect pending instances and clear the set
  const pending = [...pendingRefreshes];
  pendingRefreshes.clear();

  if (pending.length === 0) {
    // No specific pending refreshes, but refresh all as a safety net
    await refreshAllSatelliteTokens();
    return;
  }

  await Promise.allSettled(
    pending.map((url) => refreshSatelliteToken(url)),
  );
}

/**
 * Mark that the home connection is down, pausing satellite refreshes.
 */
export function onHomeConnectionLost(): void {
  homePaused = true;
}

/**
 * Whether satellite refreshes are currently paused due to home being down.
 */
export function isHomePaused(): boolean {
  return homePaused;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true; // fetch failures
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes('network') ||
      msg.includes('fetch') ||
      msg.includes('failed to fetch') ||
      msg.includes('aborted')
    );
  }
  return false;
}
