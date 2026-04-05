import {
  Code,
  ConnectError,
  createClient,
  type Interceptor,
  type Transport,
} from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { FederationService } from '@meza/gen/meza/v1/federation_pb.ts';
import { useFederationStore } from '../store/federation.ts';

// ---------------------------------------------------------------------------
// Transport cache
// ---------------------------------------------------------------------------

const spokeTransports = new Map<string, Transport>();

/**
 * Get (or lazily create) a ConnectRPC transport for a spoke instance.
 * Transports are stateless wrappers around fetch — no cleanup needed.
 */
export function getSpokeTransport(instanceUrl: string): Transport {
  let transport = spokeTransports.get(instanceUrl);
  if (!transport) {
    transport = createConnectTransport({
      baseUrl: instanceUrl,
      interceptors: [createSpokeAuthInterceptor(instanceUrl)],
    });
    spokeTransports.set(instanceUrl, transport);
  }
  return transport;
}

/** Remove a cached transport (call on spoke removal). */
export function removeSpokeTransport(instanceUrl: string): void {
  spokeTransports.delete(instanceUrl);
}

// ---------------------------------------------------------------------------
// Per-spoke refresh promise deduplication
// ---------------------------------------------------------------------------

const refreshPromises = new Map<string, Promise<boolean>>();

async function refreshSpokeTokens(instanceUrl: string): Promise<boolean> {
  const spoke = useFederationStore.getState().spokes[instanceUrl];
  if (!spoke?.refreshToken) {
    useFederationStore
      .getState()
      .updateSpokeStatus(instanceUrl, 'error', 'No refresh token');
    return false;
  }

  try {
    // Step 1: Get a fresh assertion from the origin.
    // Lazy import to break circular dependency with origin transport.
    const { createFederationAssertion } = await import('./federation.ts');
    const assertionToken = await createFederationAssertion(instanceUrl);

    // Re-read token from store in case another tab refreshed it.
    const freshSpoke = useFederationStore.getState().spokes[instanceUrl];
    if (!freshSpoke) return false;

    // Step 2: Call FederationRefresh on the spoke.
    const spokeClient = createClient(
      FederationService,
      getSpokeTransport(instanceUrl),
    );
    const res = await spokeClient.federationRefresh({
      refreshToken: freshSpoke.refreshToken,
      assertionToken,
    });

    // Step 3: Store new tokens.
    useFederationStore
      .getState()
      .updateSpokeTokens(instanceUrl, res.accessToken, res.refreshToken);

    return true;
  } catch (err) {
    // If origin is down or assertion fails, mark spoke as error.
    const message =
      err instanceof ConnectError ? err.message : 'Token refresh failed';
    useFederationStore
      .getState()
      .updateSpokeStatus(instanceUrl, 'error', message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Spoke auth interceptor
// ---------------------------------------------------------------------------

/**
 * Methods on the spoke that are public (don't need auth).
 * ResolveInvite is called unauthenticated to get server preview.
 */
const SPOKE_PUBLIC_METHODS = new Set([
  'meza.v1.ChatService/ResolveInvite',
  'meza.v1.FederationService/FederationJoin',
  'meza.v1.FederationService/FederationRefresh',
]);

function createSpokeAuthInterceptor(instanceUrl: string): Interceptor {
  return (next) => async (req) => {
    const procedureName = `${req.service.typeName}/${req.method.name}`;
    const isPublic = SPOKE_PUBLIC_METHODS.has(procedureName);

    if (!isPublic) {
      const spoke = useFederationStore.getState().spokes[instanceUrl];
      if (spoke?.accessToken) {
        req.header.set('Authorization', `Bearer ${spoke.accessToken}`);
      }
    }

    try {
      return await next(req);
    } catch (err) {
      if (
        !isPublic &&
        err instanceof ConnectError &&
        err.code === Code.Unauthenticated
      ) {
        // Dedup concurrent refresh calls for this spoke.
        if (!refreshPromises.has(instanceUrl)) {
          refreshPromises.set(
            instanceUrl,
            refreshSpokeTokens(instanceUrl).finally(() => {
              refreshPromises.delete(instanceUrl);
            }),
          );
        }

        const promise = refreshPromises.get(instanceUrl);
        const success = promise ? await promise : false;
        if (!success) throw err;

        // Retry with the fresh token.
        const spoke = useFederationStore.getState().spokes[instanceUrl];
        if (spoke?.accessToken) {
          req.header.set('Authorization', `Bearer ${spoke.accessToken}`);
        }
        return next(req);
      }
      throw err;
    }
  };
}
