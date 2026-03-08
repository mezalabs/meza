import {
  HOME_INSTANCE,
  type InstanceCapabilities,
  useInstanceStore,
  useServerStore,
} from '@meza/core';
import { useMemo } from 'react';

/**
 * Resolve which instance URL a server belongs to.
 * Returns HOME_INSTANCE for home servers, or the satellite URL.
 */
export function useServerInstanceUrl(serverId: string | undefined): string {
  const byInstance = useServerStore((s) => s.byInstance);
  return useMemo(() => {
    if (!serverId) return HOME_INSTANCE;
    for (const [instanceUrl, servers] of Object.entries(byInstance)) {
      if (servers[serverId]) return instanceUrl;
    }
    return HOME_INSTANCE;
  }, [serverId, byInstance]);
}

/**
 * Get the capabilities of an instance. Returns undefined if the instance
 * is not connected (capabilities are only available in connected state).
 */
export function useInstanceCapabilities(
  instanceUrl: string,
): InstanceCapabilities | undefined {
  return useInstanceStore((s) => {
    const inst = s.instances[instanceUrl];
    if (inst?.status === 'connected') return inst.capabilities;
    return undefined;
  });
}

/**
 * Check whether a satellite instance is offline (reconnecting or error).
 * Home instances are never considered offline by this hook.
 */
export function useSatelliteOffline(instanceUrl: string): boolean {
  return useInstanceStore((s) => {
    if (instanceUrl === HOME_INSTANCE) return false;
    const inst = s.instances[instanceUrl];
    if (!inst) return false;
    return inst.status === 'reconnecting' || inst.status === 'error';
  });
}

/**
 * Get the connection status string for a satellite instance.
 */
export function useSatelliteStatus(
  instanceUrl: string,
): 'connecting' | 'connected' | 'reconnecting' | 'error' | undefined {
  return useInstanceStore((s) => {
    if (instanceUrl === HOME_INSTANCE) return 'connected';
    return s.instances[instanceUrl]?.status;
  });
}
