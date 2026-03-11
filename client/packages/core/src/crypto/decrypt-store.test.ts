import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateIdentityKeypair } from './primitives.ts';

// Mock API module
vi.mock('../api/keys.ts', () => ({
  getKeyEnvelopes: vi.fn(),
  storeKeyEnvelopes: vi.fn(),
  rotateChannelKeyRpc: vi.fn(),
}));

// Mock storage module
vi.mock('./storage.ts', () => ({
  storeChannelKeys: vi.fn(),
  loadChannelKeys: vi.fn().mockResolvedValue(null),
}));

const { clearChannelKeyCache, createChannelKey, initChannelKeys } =
  await import('./channel-keys.ts');

const alice = generateIdentityKeypair();

vi.mock('./session.ts', () => ({
  getIdentity: vi.fn(() => alice),
}));

const { encryptMessage, buildMessageContent } = await import('./messages.ts');
const { decryptAndUpdateMessage } = await import('./decrypt-store.ts');
const { useMessageStore } = await import('../store/messages.ts');

beforeEach(() => {
  vi.clearAllMocks();
  clearChannelKeyCache();
  const masterKey = new Uint8Array(32);
  crypto.getRandomValues(masterKey);
  initChannelKeys(alice, masterKey);
  useMessageStore.getState().reset();
});

/** Helper: create an encrypted message and seed it into the store. */
async function seedEncryptedMessage(
  channelId: string,
  messageId: string,
  text: string,
  attachments: Array<{
    id: string;
    filename: string;
    contentType: string;
  }> = [],
) {
  const content = buildMessageContent(text);
  const encrypted = await encryptMessage(channelId, content);

  const storeAttachments = attachments.map((a) => ({
    id: a.id,
    filename: a.filename,
    contentType: a.contentType,
    sizeBytes: BigInt(0),
    url: '',
    encryptedKey: new Uint8Array(),
    width: 0,
    height: 0,
    hasThumbnail: false,
    microThumbnail: new Uint8Array(),
    $typeName: 'meza.v1.Attachment' as const,
    $unknown: undefined,
  }));

  const msg = {
    id: messageId,
    channelId,
    authorId: 'alice',
    encryptedContent: encrypted.data,
    keyVersion: encrypted.keyVersion,
    attachments: storeAttachments,
    createdAt: undefined,
    editedAt: undefined,
    replyToId: '',
    replyPreview: undefined,
    embeds: [],
    $typeName: 'meza.v1.Message' as const,
    $unknown: undefined,
  };

  useMessageStore.getState().setMessages(channelId, [msg as never]);
  return msg;
}

describe('decryptAndUpdateMessage', () => {
  it('decrypts an encrypted message and updates the store', async () => {
    createChannelKey('01HZXK5M8E3J6Q9P2RVTYWN4AB');
    const msg = await seedEncryptedMessage('01HZXK5M8E3J6Q9P2RVTYWN4AB', 'msg-1', 'hello world');

    const result = await decryptAndUpdateMessage('01HZXK5M8E3J6Q9P2RVTYWN4AB', msg, alice.publicKey);

    expect(result).toBe(true);

    const stored = useMessageStore.getState().byId['01HZXK5M8E3J6Q9P2RVTYWN4AB']?.['msg-1'];
    expect(stored).toBeDefined();
    expect(stored?.keyVersion).toBe(0);
    const text = new TextDecoder().decode(stored?.encryptedContent);
    expect(text).toBe('hello world');
  });

  it('returns true on successful decrypt', async () => {
    createChannelKey('01HZXK5M8E3J6Q9P2RVTYWN4AB');
    const msg = await seedEncryptedMessage('01HZXK5M8E3J6Q9P2RVTYWN4AB', 'msg-1', 'test');

    const result = await decryptAndUpdateMessage('01HZXK5M8E3J6Q9P2RVTYWN4AB', msg, alice.publicKey);
    expect(result).toBe(true);
  });

  it('returns false when message is no longer in the store', async () => {
    createChannelKey('01HZXK5M8E3J6Q9P2RVTYWN4AB');
    const msg = await seedEncryptedMessage('01HZXK5M8E3J6Q9P2RVTYWN4AB', 'msg-1', 'ephemeral');

    // Remove message from store before decrypt completes
    useMessageStore.getState().removeMessage('01HZXK5M8E3J6Q9P2RVTYWN4AB', 'msg-1');

    const result = await decryptAndUpdateMessage('01HZXK5M8E3J6Q9P2RVTYWN4AB', msg, alice.publicKey);
    expect(result).toBe(false);
  });

  it('returns false when message already decrypted (idempotency guard)', async () => {
    createChannelKey('01HZXK5M8E3J6Q9P2RVTYWN4AB');
    const msg = await seedEncryptedMessage('01HZXK5M8E3J6Q9P2RVTYWN4AB', 'msg-1', 'already done');

    // First decrypt succeeds
    const first = await decryptAndUpdateMessage('01HZXK5M8E3J6Q9P2RVTYWN4AB', msg, alice.publicKey);
    expect(first).toBe(true);

    // Second decrypt returns false (keyVersion is now 0)
    const second = await decryptAndUpdateMessage('01HZXK5M8E3J6Q9P2RVTYWN4AB', msg, alice.publicKey);
    expect(second).toBe(false);
  });
});

describe('concurrent decrypt idempotency', () => {
  it('only the first of two concurrent decrypts writes to the store', async () => {
    createChannelKey('01HZXK5M8E3J6Q9P2RVTYWN4AB');
    const msg = await seedEncryptedMessage('01HZXK5M8E3J6Q9P2RVTYWN4AB', 'msg-1', 'race me');

    const [r1, r2] = await Promise.all([
      decryptAndUpdateMessage('01HZXK5M8E3J6Q9P2RVTYWN4AB', msg, alice.publicKey),
      decryptAndUpdateMessage('01HZXK5M8E3J6Q9P2RVTYWN4AB', msg, alice.publicKey),
    ]);

    // Exactly one should succeed
    expect([r1, r2].filter(Boolean)).toHaveLength(1);

    const stored = useMessageStore.getState().byId['01HZXK5M8E3J6Q9P2RVTYWN4AB']?.['msg-1'];
    expect(stored?.keyVersion).toBe(0);
  });

  it('three concurrent decrypts produce exactly one store update', async () => {
    createChannelKey('01HZXK5M8E3J6Q9P2RVTYWN4AB');
    const msg = await seedEncryptedMessage('01HZXK5M8E3J6Q9P2RVTYWN4AB', 'msg-1', 'triple race');

    const results = await Promise.all([
      decryptAndUpdateMessage('01HZXK5M8E3J6Q9P2RVTYWN4AB', msg, alice.publicKey),
      decryptAndUpdateMessage('01HZXK5M8E3J6Q9P2RVTYWN4AB', msg, alice.publicKey),
      decryptAndUpdateMessage('01HZXK5M8E3J6Q9P2RVTYWN4AB', msg, alice.publicKey),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('concurrent decrypts of different messages both succeed', async () => {
    createChannelKey('01HZXK5M8E3J6Q9P2RVTYWN4AB');
    const msg1 = await seedEncryptedMessage('01HZXK5M8E3J6Q9P2RVTYWN4AB', 'msg-1', 'first');
    const msg2 = await seedEncryptedMessage('01HZXK5M8E3J6Q9P2RVTYWN4AB', 'msg-2', 'second');

    // Re-seed both messages since setMessages replaces the array
    useMessageStore
      .getState()
      .setMessages('01HZXK5M8E3J6Q9P2RVTYWN4AB', [msg1 as never, msg2 as never]);

    const [r1, r2] = await Promise.all([
      decryptAndUpdateMessage('01HZXK5M8E3J6Q9P2RVTYWN4AB', msg1, alice.publicKey),
      decryptAndUpdateMessage('01HZXK5M8E3J6Q9P2RVTYWN4AB', msg2, alice.publicKey),
    ]);

    expect(r1).toBe(true);
    expect(r2).toBe(true);

    expect(useMessageStore.getState().byId['01HZXK5M8E3J6Q9P2RVTYWN4AB']?.['msg-1']?.keyVersion).toBe(0);
    expect(useMessageStore.getState().byId['01HZXK5M8E3J6Q9P2RVTYWN4AB']?.['msg-2']?.keyVersion).toBe(0);
  });
});

describe('attachment metadata enrichment', () => {
  it('enriches attachment filename/contentType from V1 JSON payload', async () => {
    createChannelKey('01HZXK5M8E3J6Q9P2RVTYWN4AB');

    // Build content with attachment metadata
    const attachments = new Map([
      [
        'att-1',
        {
          microThumb: new Uint8Array([1, 2, 3]),
          filename: 'photo.jpg',
          contentType: 'image/jpeg',
        },
      ],
    ]);
    const content = buildMessageContent('look at this', attachments);
    const encrypted = await encryptMessage('01HZXK5M8E3J6Q9P2RVTYWN4AB', content);

    // Seed a message with a placeholder attachment (empty filename/contentType)
    const storeAttachment = {
      id: 'att-1',
      filename: '',
      contentType: '',
      sizeBytes: BigInt(1024),
      url: 'https://cdn.example.com/att-1',
      encryptedKey: new Uint8Array(),
      width: 0,
      height: 0,
      hasThumbnail: false,
      microThumbnail: new Uint8Array(),
      $typeName: 'meza.v1.Attachment' as const,
      $unknown: undefined,
    };

    const msg = {
      id: 'msg-att',
      channelId: '01HZXK5M8E3J6Q9P2RVTYWN4AB',
      authorId: 'alice',
      encryptedContent: encrypted.data,
      keyVersion: encrypted.keyVersion,
      attachments: [storeAttachment],
      createdAt: undefined,
      editedAt: undefined,
      replyToId: '',
      replyPreview: undefined,
      embeds: [],
      $typeName: 'meza.v1.Message' as const,
      $unknown: undefined,
    };

    useMessageStore.getState().setMessages('01HZXK5M8E3J6Q9P2RVTYWN4AB', [msg as never]);

    const result = await decryptAndUpdateMessage('01HZXK5M8E3J6Q9P2RVTYWN4AB', msg, alice.publicKey);
    expect(result).toBe(true);

    const stored = useMessageStore.getState().byId['01HZXK5M8E3J6Q9P2RVTYWN4AB']?.['msg-att'];
    expect(stored?.attachments[0].filename).toBe('photo.jpg');
    expect(stored?.attachments[0].contentType).toBe('image/jpeg');
  });

  it('preserves attachments unchanged when no metadata in content', async () => {
    createChannelKey('01HZXK5M8E3J6Q9P2RVTYWN4AB');

    // Build text-only content (no attachment metadata)
    const content = buildMessageContent('just text');
    const encrypted = await encryptMessage('01HZXK5M8E3J6Q9P2RVTYWN4AB', content);

    const storeAttachment = {
      id: 'att-1',
      filename: 'original.pdf',
      contentType: 'application/pdf',
      sizeBytes: BigInt(2048),
      url: 'https://cdn.example.com/att-1',
      encryptedKey: new Uint8Array(),
      width: 0,
      height: 0,
      hasThumbnail: false,
      microThumbnail: new Uint8Array(),
      $typeName: 'meza.v1.Attachment' as const,
      $unknown: undefined,
    };

    const msg = {
      id: 'msg-noatt',
      channelId: '01HZXK5M8E3J6Q9P2RVTYWN4AB',
      authorId: 'alice',
      encryptedContent: encrypted.data,
      keyVersion: encrypted.keyVersion,
      attachments: [storeAttachment],
      createdAt: undefined,
      editedAt: undefined,
      replyToId: '',
      replyPreview: undefined,
      embeds: [],
      $typeName: 'meza.v1.Message' as const,
      $unknown: undefined,
    };

    useMessageStore.getState().setMessages('01HZXK5M8E3J6Q9P2RVTYWN4AB', [msg as never]);

    await decryptAndUpdateMessage('01HZXK5M8E3J6Q9P2RVTYWN4AB', msg, alice.publicKey);

    const stored = useMessageStore.getState().byId['01HZXK5M8E3J6Q9P2RVTYWN4AB']?.['msg-noatt'];
    expect(stored?.attachments[0].filename).toBe('original.pdf');
    expect(stored?.attachments[0].contentType).toBe('application/pdf');
  });
});
