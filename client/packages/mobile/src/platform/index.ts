/**
 * Platform adapters barrel export.
 *
 * Import individual adapters rather than this barrel when you need
 * tree-shaking. The crypto polyfill should always be imported separately
 * as the first import in the app entry.
 */
export { sessionStore } from './session-store';
export {
  storage,
  storeKeyBundle,
  loadKeyBundle,
  storeChannelKeys,
  loadChannelKeys,
  storeGatewaySession,
  loadGatewaySession,
  clearCryptoStorage,
} from './storage-adapter';
export { isOnline, onNetworkChange } from './network-adapter';
