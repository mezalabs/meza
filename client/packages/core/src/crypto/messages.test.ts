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

// Mock session module to return the identity
const alice = generateIdentityKeypair();
const bob = generateIdentityKeypair();

vi.mock('./session.ts', () => ({
  getIdentity: vi.fn(() => alice),
}));

const {
  base64ToUint8,
  buildMessageContent,
  decryptMessage,
  encryptMessage,
  parseMessageContent,
} = await import('./messages.ts');

beforeEach(() => {
  vi.clearAllMocks();
  clearChannelKeyCache();
  const masterKey = new Uint8Array(32);
  crypto.getRandomValues(masterKey);
  initChannelKeys(alice, masterKey);
});

describe('encryptMessage', () => {
  it('encrypts content with sign-then-encrypt', async () => {
    createChannelKey('ch1');
    const content = new TextEncoder().encode('Hello, world!');

    const result = await encryptMessage('ch1', content);

    expect(result.keyVersion).toBe(1);
    expect(result.data).toBeInstanceOf(Uint8Array);
    // data = nonce(12) + ciphertext(signature(64) + content + auth_tag(16))
    expect(result.data.length).toBeGreaterThan(12 + 64 + content.length);
  });

  it('throws when no channel key exists', async () => {
    const content = new TextEncoder().encode('test');
    await expect(encryptMessage('unknown', content)).rejects.toThrow(
      'No channel key available',
    );
  });
});

describe('decryptMessage', () => {
  it('decrypts with verify-then-return', async () => {
    createChannelKey('ch1');
    const content = new TextEncoder().encode('Hello, secure world!');

    const encrypted = await encryptMessage('ch1', content);
    const decrypted = await decryptMessage(
      'ch1',
      encrypted.keyVersion,
      encrypted.data,
      alice.publicKey,
    );

    expect(decrypted).toEqual(content);
  });

  it('decrypts empty content', async () => {
    createChannelKey('ch1');
    const content = new Uint8Array(0);

    const encrypted = await encryptMessage('ch1', content);
    const decrypted = await decryptMessage(
      'ch1',
      encrypted.keyVersion,
      encrypted.data,
      alice.publicKey,
    );

    expect(decrypted).toEqual(content);
  });

  it('decrypts large content', async () => {
    createChannelKey('ch1');
    const content = new Uint8Array(10000);
    crypto.getRandomValues(content);

    const encrypted = await encryptMessage('ch1', content);
    const decrypted = await decryptMessage(
      'ch1',
      encrypted.keyVersion,
      encrypted.data,
      alice.publicKey,
    );

    expect(decrypted).toEqual(content);
  });
});

describe('encrypt/decrypt round-trip', () => {
  it('works with multiple messages on the same channel', async () => {
    createChannelKey('ch1');

    const messages = [
      'First message',
      'Second message',
      'Third message with unicode: ',
    ].map((s) => new TextEncoder().encode(s));

    for (const content of messages) {
      const encrypted = await encryptMessage('ch1', content);
      const decrypted = await decryptMessage(
        'ch1',
        encrypted.keyVersion,
        encrypted.data,
        alice.publicKey,
      );
      expect(decrypted).toEqual(content);
    }
  });

  it('produces different ciphertext for the same plaintext', async () => {
    createChannelKey('ch1');
    const content = new TextEncoder().encode('same message');

    const enc1 = await encryptMessage('ch1', content);
    const enc2 = await encryptMessage('ch1', content);

    // Different nonces → different ciphertext
    expect(enc1.data).not.toEqual(enc2.data);

    // Both decrypt to the same content
    const dec1 = await decryptMessage(
      'ch1',
      enc1.keyVersion,
      enc1.data,
      alice.publicKey,
    );
    const dec2 = await decryptMessage(
      'ch1',
      enc2.keyVersion,
      enc2.data,
      alice.publicKey,
    );
    expect(dec1).toEqual(content);
    expect(dec2).toEqual(content);
  });
});

describe('signature verification', () => {
  it('rejects message with wrong sender public key', async () => {
    createChannelKey('ch1');
    const content = new TextEncoder().encode('authenticated message');

    const encrypted = await encryptMessage('ch1', content);

    // Try to decrypt with Bob's public key instead of Alice's
    await expect(
      decryptMessage(
        'ch1',
        encrypted.keyVersion,
        encrypted.data,
        bob.publicKey,
      ),
    ).rejects.toThrow('signature verification failed');
  });

  it('rejects tampered ciphertext', async () => {
    createChannelKey('ch1');
    const content = new TextEncoder().encode('tamper test');

    const encrypted = await encryptMessage('ch1', content);

    // Tamper with the ciphertext (after the nonce)
    const tampered = new Uint8Array(encrypted.data);
    tampered[20] ^= 0xff;

    // Should fail decryption (GCM auth tag mismatch)
    await expect(
      decryptMessage('ch1', encrypted.keyVersion, tampered, alice.publicKey),
    ).rejects.toThrow();
  });
});

describe('cross-user encryption', () => {
  it('messages encrypted by alice are decryptable with alice pubkey', async () => {
    // Set up alice's channel key cache
    clearChannelKeyCache();
    const masterKey = new Uint8Array(32);
    crypto.getRandomValues(masterKey);
    initChannelKeys(alice, masterKey);
    createChannelKey('shared-ch');

    const content = new TextEncoder().encode('From Alice');
    const encrypted = await encryptMessage('shared-ch', content);

    // Decrypt using Alice's public key (since Alice signed it)
    const decrypted = await decryptMessage(
      'shared-ch',
      encrypted.keyVersion,
      encrypted.data,
      alice.publicKey,
    );
    expect(new TextDecoder().decode(decrypted)).toBe('From Alice');
  });
});

describe('signature verification edge cases', () => {
  it('rejects empty ciphertext', async () => {
    createChannelKey('ch1');

    await expect(
      decryptMessage('ch1', 1, new Uint8Array(0), alice.publicKey),
    ).rejects.toThrow();
  });
});

describe('buildMessageContent', () => {
  it('builds text-only content with V1 format', () => {
    const content = buildMessageContent('hello');
    expect(content[0]).toBe(0x01);

    const json = JSON.parse(new TextDecoder().decode(content.subarray(1)));
    expect(json.t).toBe('hello');
    expect(json.a).toBeUndefined();
  });

  it('builds content with attachment metadata', () => {
    const microThumb = new Uint8Array([1, 2, 3, 4]);
    const attachments = new Map([
      [
        'att-1',
        {
          microThumb,
          filename: 'photo.jpg',
          contentType: 'image/jpeg',
        },
      ],
    ]);

    const content = buildMessageContent('check this out', attachments);
    expect(content[0]).toBe(0x01);

    const json = JSON.parse(new TextDecoder().decode(content.subarray(1)));
    expect(json.t).toBe('check this out');
    expect(json.a['att-1'].fn).toBe('photo.jpg');
    expect(json.a['att-1'].ct).toBe('image/jpeg');
    expect(json.a['att-1'].mt).toBeTruthy();
  });

  it('handles empty text with attachments', () => {
    const attachments = new Map([
      [
        'att-1',
        {
          microThumb: new Uint8Array([1]),
          filename: 'file.pdf',
          contentType: 'application/pdf',
        },
      ],
    ]);

    const content = buildMessageContent('', attachments);
    const json = JSON.parse(new TextDecoder().decode(content.subarray(1)));
    expect(json.t).toBe('');
    expect(json.a['att-1']).toBeDefined();
  });

  it('omits "a" key when attachments map is empty', () => {
    const content = buildMessageContent('text only', new Map());
    const json = JSON.parse(new TextDecoder().decode(content.subarray(1)));
    expect(json.a).toBeUndefined();
  });
});

describe('parseMessageContent', () => {
  it('parses V1 text-only content', () => {
    const content = buildMessageContent('hello world');
    const parsed = parseMessageContent(content);

    expect(parsed.text).toBe('hello world');
    expect(parsed.attachmentMeta).toBeUndefined();
  });

  it('parses V1 content with attachments', () => {
    const microThumb = new Uint8Array([10, 20, 30]);
    const attachments = new Map([
      [
        'att-1',
        {
          microThumb,
          filename: 'video.mp4',
          contentType: 'video/mp4',
        },
      ],
    ]);

    const content = buildMessageContent('watch this', attachments);
    const parsed = parseMessageContent(content);

    expect(parsed.text).toBe('watch this');
    expect(parsed.attachmentMeta).toBeDefined();
    expect(parsed.attachmentMeta!['att-1'].fn).toBe('video.mp4');
    expect(parsed.attachmentMeta!['att-1'].ct).toBe('video/mp4');

    // Verify micro-thumbnail round-trips through base64
    const recoveredThumb = base64ToUint8(parsed.attachmentMeta!['att-1'].mt);
    expect(recoveredThumb).toEqual(microThumb);
  });

  it('parses legacy raw UTF-8 content', () => {
    const legacy = new TextEncoder().encode('old format message');
    const parsed = parseMessageContent(legacy);

    expect(parsed.text).toBe('old format message');
    expect(parsed.attachmentMeta).toBeUndefined();
  });

  it('handles empty content', () => {
    const parsed = parseMessageContent(new Uint8Array(0));
    expect(parsed.text).toBe('');
    expect(parsed.attachmentMeta).toBeUndefined();
  });

  it('handles unicode in legacy format', () => {
    const legacy = new TextEncoder().encode('emoji test: fire');
    const parsed = parseMessageContent(legacy);
    expect(parsed.text).toBe('emoji test: fire');
  });

  it('round-trips multiple attachments', () => {
    const attachments = new Map([
      [
        'att-1',
        {
          microThumb: new Uint8Array([1, 2]),
          filename: 'photo.jpg',
          contentType: 'image/jpeg',
        },
      ],
      [
        'att-2',
        {
          microThumb: new Uint8Array([3, 4]),
          filename: 'doc.pdf',
          contentType: 'application/pdf',
        },
      ],
    ]);

    const content = buildMessageContent('files attached', attachments);
    const parsed = parseMessageContent(content);

    expect(parsed.text).toBe('files attached');
    expect(Object.keys(parsed.attachmentMeta!)).toHaveLength(2);
    expect(parsed.attachmentMeta!['att-1'].fn).toBe('photo.jpg');
    expect(parsed.attachmentMeta!['att-2'].fn).toBe('doc.pdf');
  });
});

describe('buildMessageContent + encryptMessage round-trip', () => {
  it('encrypts and decrypts V1 JSON content', async () => {
    createChannelKey('ch1');

    const content = buildMessageContent('hello with format');
    const encrypted = await encryptMessage('ch1', content);
    const decrypted = await decryptMessage(
      'ch1',
      encrypted.keyVersion,
      encrypted.data,
      alice.publicKey,
    );

    const parsed = parseMessageContent(decrypted);
    expect(parsed.text).toBe('hello with format');
  });

  it('encrypts and decrypts content with attachment metadata', async () => {
    createChannelKey('ch1');

    const attachments = new Map([
      [
        'att-1',
        {
          microThumb: new Uint8Array([255, 128, 0]),
          filename: 'sunset.webp',
          contentType: 'image/webp',
        },
      ],
    ]);

    const content = buildMessageContent('beautiful sunset', attachments);
    const encrypted = await encryptMessage('ch1', content);
    const decrypted = await decryptMessage(
      'ch1',
      encrypted.keyVersion,
      encrypted.data,
      alice.publicKey,
    );

    const parsed = parseMessageContent(decrypted);
    expect(parsed.text).toBe('beautiful sunset');
    expect(parsed.attachmentMeta!['att-1'].fn).toBe('sunset.webp');

    const thumb = base64ToUint8(parsed.attachmentMeta!['att-1'].mt);
    expect(thumb).toEqual(new Uint8Array([255, 128, 0]));
  });
});
