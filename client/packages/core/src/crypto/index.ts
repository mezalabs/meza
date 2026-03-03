/**
 * Crypto module public API.
 *
 * Static channel key E2EE: key derivation, identity management,
 * channel key operations, message encrypt/decrypt, and persistence.
 */

export {
  acquireBlobURL,
  releaseAllBlobURLs,
  releaseBlobURL,
} from './blob-urls.ts';
export {
  clearChannelKeyCache,
  createChannelKey,
  distributeKeyToMember,
  fetchAndCacheChannelKeys,
  flushChannelKeys,
  getCachedChannelIds,
  getChannelKey,
  getChannelKeysForServer,
  getLatestKeyVersion,
  hasChannelKey,
  importChannelKeys,
  initChannelKeys,
  lazyInitChannelKey,
  loadCachedChannelKeys,
  provisionChannelKeyBatched,
  redistributeChannelKeys,
  rotateChannelKey,
  wrapKeyForMembers,
} from './channel-keys.ts';
export {
  createIdentity,
  persistIdentity,
  registerPublicKey,
  restoreIdentity,
} from './credentials.ts';
export {
  decryptAndUpdateMessage,
  decryptAndUpdateMessages,
} from './decrypt-store.ts';
export {
  decryptFile,
  encryptFile,
  generateFileKey,
  unwrapFileKey,
  wrapFileKey,
} from './file-encryption.ts';
export {
  createInviteKeyBundle,
  importInviteKeyBundle,
} from './invite-keys.ts';
export {
  aesGcmDecrypt,
  aesGcmEncrypt,
  type DerivedKeys,
  deriveKeys,
} from './keys.ts';
export {
  type AttachmentMeta,
  base64ToUint8,
  buildMessageContent,
  decryptMessage,
  type EncryptedMessage,
  encryptMessage,
  type ParsedMessageContent,
  parseMessageContent,
  safeParseMessageText,
} from './messages.ts';
export {
  clearAesKeyCache,
  decryptPayload,
  deserializeIdentity,
  edToX25519Public,
  edToX25519Secret,
  encryptPayload,
  generateChannelKey,
  generateIdentityKeypair,
  type IdentityKeypair,
  serializeIdentity,
  signMessage,
  unwrapChannelKey,
  verifySignature,
  wrapChannelKey,
} from './primitives.ts';
export {
  decryptRecoveryBundle,
  deriveRecoveryKey,
  encryptRecoveryBundle,
  generateRecoveryPhrase,
  validateRecoveryPhrase,
} from './recovery.ts';
export {
  bootstrapSession,
  getIdentity,
  isSessionReady,
  onSessionReady,
  teardownSession,
} from './session.ts';
export {
  clearCryptoStorage,
  loadChannelKeys,
  loadKeyBundle,
  storeChannelKeys,
  storeKeyBundle,
} from './storage.ts';
export {
  generateImageThumbnail,
  generateVideoThumbnail,
} from './thumbnails.ts';
