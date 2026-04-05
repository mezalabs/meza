import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { ChatService } from '@meza/gen/meza/v1/chat_pb.ts';
import { FederationService } from '@meza/gen/meza/v1/federation_pb.ts';
import { useChannelStore } from '../store/channels.ts';
import { useFederationStore } from '../store/federation.ts';
import { useMemberStore } from '../store/members.ts';
import { useServerStore } from '../store/servers.ts';
import { transport } from './client.ts';
import { getSpokeTransport } from './federation-transport.ts';

// ---------------------------------------------------------------------------
// Origin-side clients (use the origin transport)
// ---------------------------------------------------------------------------

const originFedClient = createClient(FederationService, transport);

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

/** Validate a URL is safe to use as a federation invite. */
export function validateFederationUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('Invalid URL');
  }

  if (url.protocol !== 'https:') {
    throw new Error('Federation requires HTTPS');
  }
  if (url.username || url.password) {
    throw new Error('URLs with credentials are not allowed');
  }
  return url.href;
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

export function mapFederationError(err: unknown): string {
  if (err instanceof ConnectError) {
    switch (err.code) {
      case Code.InvalidArgument:
        return 'Invalid invite URL or code';
      case Code.NotFound:
        return 'Invite not found or expired';
      case Code.AlreadyExists:
        return 'You are already a member of this server';
      case Code.PermissionDenied:
        return 'You have been banned from this server';
      case Code.Internal:
        return 'The remote server encountered an error';
      case Code.Unavailable:
        return 'The remote server is unreachable';
      case Code.Unauthenticated:
        return 'Authentication failed — please try again';
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : 'Federation operation failed';
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Resolve a remote invite URL to an instanceUrl + inviteCode.
 * Called on the **origin** transport.
 */
export async function resolveRemoteInvite(inviteUrl: string): Promise<{
  instanceUrl: string;
  inviteCode: string;
}> {
  const res = await originFedClient.resolveRemoteInvite({ inviteUrl });
  return { instanceUrl: res.instanceUrl, inviteCode: res.inviteCode };
}

/**
 * Create a scoped federation assertion for a target spoke.
 * Called on the **origin** transport.
 */
export async function createFederationAssertion(
  targetInstanceUrl: string,
): Promise<string> {
  const res = await originFedClient.createFederationAssertion({
    targetInstanceUrl,
  });
  return res.assertionToken;
}

/**
 * Join a spoke server using a federation assertion.
 * Called on the **spoke** transport. Hydrates stores on success.
 */
export async function federationJoin(
  instanceUrl: string,
  assertionToken: string,
  inviteCode: string,
): Promise<{ serverId: string }> {
  const spokeClient = createClient(
    FederationService,
    getSpokeTransport(instanceUrl),
  );
  const res = await spokeClient.federationJoin({ assertionToken, inviteCode });

  if (!res.server) {
    throw new Error('Federation join returned no server');
  }

  // Hydrate stores from the response.
  const { server } = res;
  useServerStore.getState().addServer(server);
  if (res.channels.length > 0) {
    useChannelStore.getState().setChannels(server.id, res.channels);
  }
  if (res.members.length > 0) {
    useMemberStore.getState().setMembers(server.id, res.members);
  }

  // Add spoke to federation store.
  useFederationStore.getState().addSpoke({
    instanceUrl,
    accessToken: res.accessToken,
    refreshToken: res.refreshToken,
    shadowUserId: res.userId,
    serverId: server.id,
  });

  return { serverId: server.id };
}

/**
 * Leave a spoke server.
 * Called on the **spoke** transport.
 */
export async function federationLeave(
  instanceUrl: string,
  serverId: string,
): Promise<void> {
  try {
    const spokeClient = createClient(
      FederationService,
      getSpokeTransport(instanceUrl),
    );
    await spokeClient.federationLeave({ serverId });
  } catch {
    // Best-effort — spoke may already be unreachable.
  }
}

/**
 * Try to resolve a spoke invite for the preview (server name, member count).
 * Uses the spoke's ChatService ResolveInvite (unauthenticated).
 * Returns null if the spoke doesn't respond.
 */
export async function resolveSpokeInvitePreview(
  instanceUrl: string,
  inviteCode: string,
): Promise<{ name: string; memberCount: number } | null> {
  try {
    const spokeChat = createClient(ChatService, getSpokeTransport(instanceUrl));
    const res = await spokeChat.resolveInvite({ code: inviteCode });
    if (res.server) {
      return { name: res.server.name, memberCount: res.memberCount };
    }
    return null;
  } catch {
    return null;
  }
}
