import { ConnectError } from '@connectrpc/connect';
import { FederationService } from '@meza/gen/meza/v1/federation_pb.ts';
import { createInstanceClient } from './client.ts';
import {
  scheduleTokenRefresh,
  clearTokenRefreshTimer,
  clearAllTokenRefreshTimers,
} from './federation-refresh.ts';
import { useInstanceStore } from '../store/instances.ts';
import { useServerStore } from '../store/servers.ts';
import { useChannelStore } from '../store/channels.ts';
import { useMemberStore } from '../store/members.ts';
import { useRoleStore } from '../store/roles.ts';
import {
  connectInstance,
  disconnectInstance,
  normalizeInstanceUrl,
} from '../gateway/gateway.ts';
import { removeTransport } from './client.ts';

/**
 * Home server federation client (for assertions, membership sync).
 */
function homeClient() {
  return createInstanceClient(FederationService);
}

/**
 * Satellite federation client.
 */
function satelliteClient(instanceUrl: string) {
  return createInstanceClient(FederationService, instanceUrl);
}

function formatFederationError(err: unknown): string {
  if (err instanceof ConnectError) {
    return err.message || 'Federation request failed';
  }
  if (err instanceof Error) {
    return err.message;
  }
  return 'An unknown error occurred';
}

export interface FederationJoinResult {
  serverId: string;
  serverName: string;
  instanceUrl: string;
}

/**
 * Join a guild on a remote satellite instance via federation.
 *
 * Flow:
 * 1. Resolve the invite URL on the home server to get instance_url + invite_code
 * 2. Get a scoped assertion token from the home server
 * 3. Join the satellite via FederationJoin with the assertion + invite code
 * 4. Store instance and tokens
 * 5. Sync membership to the home server (non-critical)
 * 6. Open WebSocket to the satellite
 * 7. Populate stores with server/channel/member data
 */
export async function joinSatelliteGuild(
  inviteUrl: string,
): Promise<FederationJoinResult> {
  // 1. Resolve the invite URL on the home server
  let resolvedUrl: string;
  let inviteCode: string;
  try {
    const resolveRes = await homeClient().resolveRemoteInvite({ inviteUrl });
    resolvedUrl = resolveRes.instanceUrl;
    inviteCode = resolveRes.inviteCode;
  } catch (err) {
    throw new Error(
      `Failed to resolve invite: ${formatFederationError(err)}`,
      { cause: err },
    );
  }

  const normalizedUrl = normalizeInstanceUrl(resolvedUrl);

  // 2. Get a scoped assertion token from the home server
  let assertionToken: string;
  try {
    const assertionRes = await homeClient().createFederationAssertion({
      targetInstanceUrl: normalizedUrl,
    });
    assertionToken = assertionRes.assertionToken;
  } catch (err) {
    throw new Error(
      `Failed to create federation assertion: ${formatFederationError(err)}`,
      { cause: err },
    );
  }

  // 3. Register the instance so transports can be created for it
  useInstanceStore.getState().addInstance(normalizedUrl);

  // 4. Join the satellite via FederationJoin
  let accessToken: string;
  let refreshToken: string;
  let userId: string;
  let serverId: string;
  let serverName: string;
  try {
    const joinRes = await satelliteClient(normalizedUrl).federationJoin({
      assertionToken,
      inviteCode,
    });

    accessToken = joinRes.accessToken;
    refreshToken = joinRes.refreshToken;
    userId = joinRes.userId;

    if (!joinRes.server) {
      throw new Error('Satellite did not return server data');
    }

    serverId = joinRes.server.id;
    serverName = joinRes.server.name;

    // 5. Store tokens in the instance store
    useInstanceStore.getState().updateInstanceStatus(normalizedUrl, {
      status: 'connected',
      url: normalizedUrl,
      accessToken,
      refreshToken,
      capabilities: {
        protocolVersion: 1,
        mediaEnabled: true,
        voiceEnabled: false,
        notificationsEnabled: false,
      },
    });

    // 6. Populate stores with server/channel/member data
    useServerStore.getState().addServer(joinRes.server, normalizedUrl);

    if (joinRes.channels.length > 0) {
      useChannelStore
        .getState()
        .setChannels(serverId, joinRes.channels, normalizedUrl);
    }

    if (joinRes.members.length > 0) {
      useMemberStore
        .getState()
        .setMembers(serverId, joinRes.members, normalizedUrl);
    }
  } catch (err) {
    // Clean up on failure
    useInstanceStore.getState().removeInstance(normalizedUrl);
    removeTransport(normalizedUrl);

    if (err instanceof Error && err.message === 'Satellite did not return server data') {
      throw err;
    }
    throw new Error(
      `Failed to join satellite guild: ${formatFederationError(err)}`,
      { cause: err },
    );
  }

  // 7. Sync membership to the home server (non-critical, fire-and-forget)
  homeClient()
    .storeFederatedMembership({
      satelliteUrl: normalizedUrl,
      serverId,
    })
    .catch((err) => {
      console.warn(
        'Failed to sync federation membership to home server:',
        err,
      );
    });

  // 8. Open WebSocket connection to the satellite
  connectInstance(normalizedUrl, accessToken, userId);

  // 9. Schedule proactive token refresh at 75% of TTL
  scheduleTokenRefresh(normalizedUrl, accessToken);

  // TODO: Phase C2 — push profile to satellite via UpdateFederatedProfile RPC
  // (RPC not yet defined in proto)

  // TODO: Phase C2 — hydrate remaining state (ListRoles, ListChannelGroups,
  // ListEmojis) via satellite ConnectRPC calls

  return {
    serverId,
    serverName,
    instanceUrl: normalizedUrl,
  };
}

/**
 * Leave a guild on a remote satellite instance.
 *
 * Flow:
 * 1. Leave on the satellite via FederationLeave
 * 2. Remove membership from the home server (non-critical)
 * 3. Clean up stores and disconnect if no other guilds remain on this satellite
 */
export async function leaveSatelliteGuild(
  instanceUrl: string,
  serverId: string,
): Promise<void> {
  const normalizedUrl = normalizeInstanceUrl(instanceUrl);

  // 1. Leave on the satellite
  try {
    await satelliteClient(normalizedUrl).federationLeave({ serverId });
  } catch (err) {
    throw new Error(
      `Failed to leave satellite guild: ${formatFederationError(err)}`,
      { cause: err },
    );
  }

  // 2. Remove from home server membership sync (non-critical)
  homeClient()
    .removeFederatedMembership({
      satelliteUrl: normalizedUrl,
      serverId,
    })
    .catch((err) => {
      console.warn(
        'Failed to remove federation membership from home server:',
        err,
      );
    });

  // 3. Remove guild data from stores (scoped to this server, not the whole instance)
  useServerStore.getState().removeServer(serverId, normalizedUrl);
  useChannelStore.getState().removeServerChannels(serverId, normalizedUrl);
  useMemberStore.getState().removeServerMembers(serverId, normalizedUrl);
  useRoleStore.getState().removeServerRoles(serverId, normalizedUrl);

  // 4. Check if other guilds exist on this satellite
  const remainingServers = useServerStore.getState().getServers(normalizedUrl);
  if (Object.keys(remainingServers).length === 0) {
    // No more guilds on this satellite — disconnect and clean up everything
    clearTokenRefreshTimer(normalizedUrl);
    disconnectInstance(normalizedUrl);
    useInstanceStore.getState().removeInstance(normalizedUrl);
    useMemberStore.getState().removeInstanceData(normalizedUrl);
    removeTransport(normalizedUrl);
  }
}

/**
 * List all federated memberships stored on the home server.
 * Used for multi-device sync and reconnection on startup.
 */
export async function listFederatedMemberships() {
  try {
    const res = await homeClient().listFederatedMemberships({});
    return res.memberships;
  } catch (err) {
    throw new Error(
      `Failed to list federated memberships: ${formatFederationError(err)}`,
      { cause: err },
    );
  }
}

/**
 * Reconnect to all federated satellite instances on app open or new device.
 *
 * Fetches memberships from the home server (source of truth), groups by
 * satellite URL, and connects to each in parallel via FederationRefresh
 * (not Join — we already have an account on the satellite).
 *
 * Call this after successful home login / auth restore.
 */
export async function reconnectFederatedInstances(): Promise<void> {
  let memberships: Awaited<ReturnType<typeof listFederatedMemberships>>;
  try {
    memberships = await listFederatedMemberships();
  } catch (err) {
    console.warn(
      '[Federation] failed to fetch memberships for reconnect:',
      err,
    );
    return;
  }

  if (memberships.length === 0) return;

  // Group by satellite URL
  const bySatellite = new Map<
    string,
    typeof memberships
  >();
  for (const m of memberships) {
    const url = normalizeInstanceUrl(m.instanceUrl);
    let group = bySatellite.get(url);
    if (!group) {
      group = [];
      bySatellite.set(url, group);
    }
    group.push(m);
  }

  await Promise.allSettled(
    [...bySatellite.entries()].map(async ([url, _members]) => {
      try {
        // Ensure instance is registered
        useInstanceStore.getState().addInstance(url);

        // Request assertion from the home server
        const assertionRes = await homeClient().createFederationAssertion({
          targetInstanceUrl: url,
        });

        // Get the existing instance state for refresh token
        const instance = useInstanceStore.getState().getInstance(url);
        const existingRefreshToken =
          instance &&
          (instance.status === 'connected' ||
            instance.status === 'reconnecting')
            ? instance.refreshToken
            : '';

        // Connect to satellite via FederationRefresh (or Join if no refresh token)
        let accessToken: string;
        let refreshToken: string;
        let userId: string;

        if (existingRefreshToken) {
          // Refresh existing session
          const refreshRes = await satelliteClient(url).federationRefresh({
            assertionToken: assertionRes.assertionToken,
            refreshToken: existingRefreshToken,
          });
          accessToken = refreshRes.accessToken;
          refreshToken = refreshRes.refreshToken;
          // userId not returned from refresh — we don't need it for reconnect
          userId = '';
        } else {
          // No refresh token — this is a new device. We need to re-join
          // using the first membership's server context. The satellite will
          // recognize us by our federation identity and return existing state.
          // For now, skip instances without a refresh token — they'll need
          // a fresh invite or manual rejoin.
          console.warn(
            `[Federation] no refresh token for ${url}, skipping reconnect`,
          );
          return;
        }

        // Update instance store with fresh tokens
        useInstanceStore.getState().updateInstanceStatus(url, {
          status: 'connected',
          url,
          accessToken,
          refreshToken,
          capabilities: {
            protocolVersion: 1,
            mediaEnabled: true,
            voiceEnabled: false,
            notificationsEnabled: false,
          },
        });

        // Schedule proactive token refresh
        scheduleTokenRefresh(url, accessToken);

        // Open WebSocket connection
        connectInstance(url, accessToken, userId);
      } catch (err) {
        console.warn(
          `[Federation] reconnect failed for satellite ${url}:`,
          err,
        );
        // Update instance status to error but don't remove — user may retry
        useInstanceStore.getState().updateInstanceStatus(url, {
          status: 'error',
          url,
          error: err instanceof Error ? err.message : 'Reconnect failed',
        });
      }
    }),
  );
}

/**
 * Handle a FEDERATION_REMOVED event from a satellite (ban/kick).
 *
 * Cleans up all local state for the removed guild and notifies the
 * home server to remove the membership record.
 */
export async function handleFederationRemoved(
  instanceUrl: string,
  serverId: string,
  reason: string,
): Promise<void> {
  const normalizedUrl = normalizeInstanceUrl(instanceUrl);

  console.warn(
    `[Federation] removed from server ${serverId} on ${normalizedUrl}: ${reason}`,
  );

  // 1. Remove guild data from stores
  useServerStore.getState().removeServer(serverId, normalizedUrl);
  useChannelStore.getState().removeServerChannels(serverId, normalizedUrl);
  useMemberStore.getState().removeInstanceData(normalizedUrl);

  // 2. Remove membership from home server (non-critical)
  homeClient()
    .removeFederatedMembership({
      satelliteUrl: normalizedUrl,
      serverId,
    })
    .catch((err) => {
      console.warn(
        'Failed to remove federation membership from home server:',
        err,
      );
    });

  // 3. Check if other guilds remain on this satellite
  const remainingServers = useServerStore.getState().getServers(normalizedUrl);
  if (Object.keys(remainingServers).length === 0) {
    // No more guilds — disconnect and clean up
    clearTokenRefreshTimer(normalizedUrl);
    disconnectInstance(normalizedUrl);
    useInstanceStore.getState().removeInstance(normalizedUrl);
    removeTransport(normalizedUrl);
  }
}

/**
 * Clean up all federation refresh timers. Called during logout.
 */
export { clearAllTokenRefreshTimers };

/**
 * Detect whether an invite URL points to a remote (federated) instance
 * rather than the home instance.
 */
export function isFederatedInvite(inviteUrl: string): boolean {
  try {
    const parsed = new URL(inviteUrl);
    const inviteHost = parsed.hostname.toLowerCase();

    // Compare against the home instance URL
    // The home instance uses relative URLs in dev, so we check against
    // window.location if available
    if (typeof window !== 'undefined') {
      const homeHost = window.location.hostname.toLowerCase();
      return inviteHost !== homeHost;
    }

    return false;
  } catch {
    // Not a valid URL — treat as a plain invite code, not federated
    return false;
  }
}
