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
  deriveVerificationCode,
  generateRecoveryKeypair,
  unwrapIdentityFromRecovery,
  wrapIdentityForRecovery,
} from './device-recovery.ts';
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
  cachePublicKey,
  clearVerification,
  getVerificationStatus,
  isVerificationValid,
  type KeyCacheResult,
  markVerified,
} from './key-monitor.ts';
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
  deriveVoiceKey,
  deserializeIdentity,
  edToX25519Public,
  edToX25519Secret,
  encryptPayload,
  generateChannelKey,
  generateIdentityKeypair,
  type IdentityKeypair,
  rejectLowOrderPoint,
  serializeIdentity,
  signMessage,
  unwrapChannelKey,
  verifySignature,
  wrapChannelKey,
} from './primitives.ts';
export {
  computeFingerprint,
  computeSafetyNumber,
  formatSafetyNumber,
} from './safety-number.ts';
export {
  decryptRecoveryBundle,
  deriveRecoveryKey,
  deriveRecoveryVerifier,
  encryptRecoveryBundle,
  generateRecoveryPhrase,
  validateRecoveryPhrase,
} from './recovery.ts';
export {
  bootstrapSession,
  getIdentity,
  isSessionReady,
  onCrossTabTeardown,
  onSessionReady,
  teardownSession,
} from './session.ts';
export {
  type CachedKeyRecord,
  clearCryptoStorage,
  loadAllVerifications,
  loadChannelKeys,
  loadKeyBundle,
  storeChannelKeys,
  storeKeyBundle,
  type VerificationRecord,
} from './storage.ts';
export {
  generateImageThumbnail,
  generateVideoThumbnail,
} from './thumbnails.ts';
