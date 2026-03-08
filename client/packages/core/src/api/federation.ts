import { ConnectError } from '@connectrpc/connect';
import { FederationService } from '@meza/gen/meza/v1/federation_pb.ts';
import { createInstanceClient } from './client.ts';
import { useInstanceStore } from '../store/instances.ts';
import { useServerStore } from '../store/servers.ts';
import { useChannelStore } from '../store/channels.ts';
import { useMemberStore } from '../store/members.ts';
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

  // 3. Remove guild data from stores
  useServerStore.getState().removeServer(serverId, normalizedUrl);
  useChannelStore.getState().removeServerChannels(serverId, normalizedUrl);
  useMemberStore.getState().removeInstanceData(normalizedUrl);

  // 4. Check if other guilds exist on this satellite
  const remainingServers = useServerStore.getState().getServers(normalizedUrl);
  if (Object.keys(remainingServers).length === 0) {
    // No more guilds on this satellite — disconnect and clean up
    disconnectInstance(normalizedUrl);
    useInstanceStore.getState().removeInstance(normalizedUrl);
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
