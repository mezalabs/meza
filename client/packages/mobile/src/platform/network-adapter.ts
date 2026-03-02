/**
 * Network state adapter: replaces navigator.onLine with @react-native-community/netinfo.
 *
 * Provides a reactive network state that @meza/core's gateway can subscribe to
 * for reconnection logic.
 */
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';

let isConnected = true;

// Subscribe to network changes at module load
NetInfo.addEventListener((state: NetInfoState) => {
  isConnected = state.isConnected ?? true;
});

/**
 * Check if the device is currently online.
 * Replaces `navigator.onLine` for React Native.
 */
export function isOnline(): boolean {
  return isConnected;
}

/**
 * Subscribe to network state changes.
 * Returns an unsubscribe function.
 */
export function onNetworkChange(
  callback: (connected: boolean) => void,
): () => void {
  return NetInfo.addEventListener((state: NetInfoState) => {
    callback(state.isConnected ?? true);
  });
}
