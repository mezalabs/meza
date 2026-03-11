import { describe, expect, it } from 'vitest';
import {
  buildContextAAD,
  buildKeyWrapAAD,
  PURPOSE_FILE_KEY,
  PURPOSE_KEY_WRAP,
  PURPOSE_MESSAGE,
} from './aad.ts';

/** 26-char ULID for testing */
const TEST_CHANNEL_ID = '01HZXK5M8E3J6Q9P2RVTYWN4AB';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

describe('buildContextAAD', () => {
  it('builds correct 31-byte AAD for message purpose', () => {
    const aad = buildContextAAD(PURPOSE_MESSAGE, TEST_CHANNEL_ID, 1);

    expect(aad.length).toBe(31);
    expect(aad[0]).toBe(0x01); // PURPOSE_MESSAGE
    // channelId UTF-8 bytes at offset 1-26
    const channelIdBytes = new TextDecoder().decode(aad.slice(1, 27));
    expect(channelIdBytes).toBe(TEST_CHANNEL_ID);
    // keyVersion as big-endian uint32 at offset 27-30
    const keyVersion = new DataView(aad.buffer).getUint32(27);
    expect(keyVersion).toBe(1);
  });

  it('builds correct AAD for file key purpose', () => {
    const aad = buildContextAAD(PURPOSE_FILE_KEY, TEST_CHANNEL_ID, 42);

    expect(aad.length).toBe(31);
    expect(aad[0]).toBe(0x03); // PURPOSE_FILE_KEY
    const keyVersion = new DataView(aad.buffer).getUint32(27);
    expect(keyVersion).toBe(42);
  });

  it('encodes keyVersion=0 correctly', () => {
    const aad = buildContextAAD(PURPOSE_MESSAGE, TEST_CHANNEL_ID, 0);
    const keyVersion = new DataView(aad.buffer).getUint32(27);
    expect(keyVersion).toBe(0);
  });

  it('encodes keyVersion=0xFFFFFFFF (max uint32) correctly', () => {
    const aad = buildContextAAD(PURPOSE_MESSAGE, TEST_CHANNEL_ID, 0xffffffff);
    const keyVersion = new DataView(aad.buffer).getUint32(27);
    expect(keyVersion).toBe(0xffffffff);
  });

  it('message AAD differs from file key AAD for same inputs', () => {
    const messageAAD = buildContextAAD(PURPOSE_MESSAGE, TEST_CHANNEL_ID, 1);
    const fileKeyAAD = buildContextAAD(PURPOSE_FILE_KEY, TEST_CHANNEL_ID, 1);

    expect(messageAAD).not.toEqual(fileKeyAAD);
    // Only the purpose byte differs
    expect(messageAAD[0]).toBe(0x01);
    expect(fileKeyAAD[0]).toBe(0x03);
    expect(messageAAD.slice(1)).toEqual(fileKeyAAD.slice(1));
  });

  it('rejects channelId shorter than 26 bytes', () => {
    expect(() => buildContextAAD(PURPOSE_MESSAGE, 'short', 1)).toThrow(
      'channelId must be 26 bytes',
    );
  });

  it('rejects channelId longer than 26 bytes', () => {
    const longId = '01HZXK5M8E3J6Q9P2RVTYWN4ABCD'; // 30 chars
    expect(() => buildContextAAD(PURPOSE_MESSAGE, longId, 1)).toThrow(
      'channelId must be 26 bytes',
    );
  });

  it('rejects empty channelId', () => {
    expect(() => buildContextAAD(PURPOSE_MESSAGE, '', 1)).toThrow(
      'channelId must be 26 bytes',
    );
  });

  it('produces deterministic output', () => {
    const aad1 = buildContextAAD(PURPOSE_MESSAGE, TEST_CHANNEL_ID, 3);
    const aad2 = buildContextAAD(PURPOSE_MESSAGE, TEST_CHANNEL_ID, 3);
    expect(aad1).toEqual(aad2);
  });

  it('different channelIds produce different AADs', () => {
    const channelA = '01HZXK5M8E3J6Q9P2RVTYWN4AB';
    const channelB = '01HZXK5M8E3J6Q9P2RVTYWN4AC';
    const aadA = buildContextAAD(PURPOSE_MESSAGE, channelA, 1);
    const aadB = buildContextAAD(PURPOSE_MESSAGE, channelB, 1);
    expect(aadA).not.toEqual(aadB);
  });

  it('different keyVersions produce different AADs', () => {
    const aad1 = buildContextAAD(PURPOSE_MESSAGE, TEST_CHANNEL_ID, 1);
    const aad2 = buildContextAAD(PURPOSE_MESSAGE, TEST_CHANNEL_ID, 2);
    expect(aad1).not.toEqual(aad2);
  });

  // Test vector for cross-implementation verification
  it('produces expected hex for known inputs', () => {
    const aad = buildContextAAD(PURPOSE_MESSAGE, TEST_CHANNEL_ID, 3);
    const hex = toHex(aad);
    // purpose=01, channelId="01HZXK5M8E3J6Q9P2RVTYWN4AB" (hex of ASCII), keyVersion=00000003
    const expectedChannelHex = toHex(new TextEncoder().encode(TEST_CHANNEL_ID));
    expect(hex).toBe(`01${expectedChannelHex}00000003`);
  });
});

describe('buildKeyWrapAAD', () => {
  it('builds correct 59-byte AAD', () => {
    const recipientEdPub = new Uint8Array(32);
    recipientEdPub.fill(0xab);

    const aad = buildKeyWrapAAD(TEST_CHANNEL_ID, recipientEdPub);

    expect(aad.length).toBe(59);
    expect(aad[0]).toBe(0x02); // PURPOSE_KEY_WRAP
    const channelIdBytes = new TextDecoder().decode(aad.slice(1, 27));
    expect(channelIdBytes).toBe(TEST_CHANNEL_ID);
    expect(aad.slice(27)).toEqual(recipientEdPub);
  });

  it('rejects channelId not 26 bytes', () => {
    const edPub = new Uint8Array(32);
    expect(() => buildKeyWrapAAD('short', edPub)).toThrow(
      'channelId must be 26 bytes',
    );
  });

  it('rejects recipientEdPub not 32 bytes', () => {
    const badPub = new Uint8Array(16);
    expect(() => buildKeyWrapAAD(TEST_CHANNEL_ID, badPub)).toThrow(
      'recipientEdPub must be 32 bytes',
    );
  });

  it('produces different AAD for different recipients', () => {
    const pubA = new Uint8Array(32).fill(0x01);
    const pubB = new Uint8Array(32).fill(0x02);

    const aadA = buildKeyWrapAAD(TEST_CHANNEL_ID, pubA);
    const aadB = buildKeyWrapAAD(TEST_CHANNEL_ID, pubB);
    expect(aadA).not.toEqual(aadB);
  });

  it('key wrap AAD differs from context AAD (different purpose byte)', () => {
    const edPub = new Uint8Array(32).fill(0xcc);
    const keyWrapAAD = buildKeyWrapAAD(TEST_CHANNEL_ID, edPub);
    const messageAAD = buildContextAAD(PURPOSE_MESSAGE, TEST_CHANNEL_ID, 1);

    // Different lengths (59 vs 31) and different purpose bytes
    expect(keyWrapAAD.length).not.toBe(messageAAD.length);
    expect(keyWrapAAD[0]).toBe(PURPOSE_KEY_WRAP);
    expect(messageAAD[0]).toBe(PURPOSE_MESSAGE);
  });

  // Test vector for cross-implementation verification
  it('produces expected hex for known inputs', () => {
    const edPub = new Uint8Array(32);
    for (let i = 0; i < 32; i++) edPub[i] = i;

    const aad = buildKeyWrapAAD(TEST_CHANNEL_ID, edPub);
    const hex = toHex(aad);
    const expectedChannelHex = toHex(new TextEncoder().encode(TEST_CHANNEL_ID));
    const expectedPubHex = toHex(edPub);
    expect(hex).toBe(`02${expectedChannelHex}${expectedPubHex}`);
  });
});

describe('purpose byte constants', () => {
  it('has unique purpose bytes', () => {
    const purposes = [PURPOSE_MESSAGE, PURPOSE_KEY_WRAP, PURPOSE_FILE_KEY];
    expect(new Set(purposes).size).toBe(3);
  });

  it('all purpose bytes are single-byte values', () => {
    expect(PURPOSE_MESSAGE).toBeGreaterThanOrEqual(0);
    expect(PURPOSE_MESSAGE).toBeLessThanOrEqual(255);
    expect(PURPOSE_KEY_WRAP).toBeGreaterThanOrEqual(0);
    expect(PURPOSE_KEY_WRAP).toBeLessThanOrEqual(255);
    expect(PURPOSE_FILE_KEY).toBeGreaterThanOrEqual(0);
    expect(PURPOSE_FILE_KEY).toBeLessThanOrEqual(255);
  });
});
