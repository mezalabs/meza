/**
 * Fetches initial data after authentication: servers, channels, DMs.
 * Also handles re-fetching on gateway reconnect.
 */

import {
  listChannels,
  listDMChannels,
  listServers,
  useAuthStore,
  useGatewayStore,
  useServerStore,
} from '@meza/core';
import { useEffect, useRef } from 'react';

export function useInitialData() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const reconnectCount = useGatewayStore((s) => s.reconnectCount);
  const hasFetched = useRef(false);

  useEffect(() => {
    if (!isAuthenticated) {
      hasFetched.current = false;
      return;
    }

    // Avoid double-fetch on mount (React strict mode)
    if (hasFetched.current && reconnectCount === 0) return;
    hasFetched.current = true;

    let ignore = false;

    async function fetchAll() {
      try {
        const servers = await listServers();
        if (ignore) return;

        // Fetch channels for each server in parallel
        const serverIds = servers.map((s) => s.id);
        await Promise.all(
          serverIds.map((serverId) =>
            listChannels(serverId).catch((err) =>
              console.error(`[data] Failed to fetch channels for ${serverId}:`, err),
            ),
          ),
        );
      } catch (err) {
        console.error('[data] Failed to fetch servers:', err);
      }

      try {
        await listDMChannels();
      } catch (err) {
        console.error('[data] Failed to fetch DMs:', err);
      }
    }

    fetchAll();
    return () => {
      ignore = true;
    };
  }, [isAuthenticated, reconnectCount]);
}
