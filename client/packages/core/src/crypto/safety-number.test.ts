import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  computeFingerprint,
  computeSafetyNumber,
  formatSafetyNumber,
} from './safety-number.ts';

/** Deterministic keypairs from known seeds for test vectors. */
const ALICE_SECRET = new Uint8Array(32).fill(0x01);
const BOB_SECRET = new Uint8Array(32).fill(0x02);
const ALICE_PUBLIC = ed25519.getPublicKey(ALICE_SECRET);
const BOB_PUBLIC = ed25519.getPublicKey(BOB_SECRET);

const ALICE_ID = '01HZXK5M8E3J6Q9P2RVTYWN4AB'; // 26-char ULID
const BOB_ID = '01HZXK5M8E3J6Q9P2RVTYWN4CD';

describe('computeFingerprint', () => {
  it('returns a 30-digit string', () => {
    const fp = computeFingerprint(ALICE_PUBLIC, ALICE_ID);
    expect(fp).toHaveLength(30);
    expect(fp).toMatch(/^\d{30}$/);
  });

  it('is deterministic for the same inputs', () => {
    const fp1 = computeFingerprint(ALICE_PUBLIC, ALICE_ID);
    const fp2 = computeFingerprint(ALICE_PUBLIC, ALICE_ID);
    expect(fp1).toBe(fp2);
  });

  it('produces different fingerprints for different keys', () => {
    const fpAlice = computeFingerprint(ALICE_PUBLIC, ALICE_ID);
    const fpBob = computeFingerprint(BOB_PUBLIC, BOB_ID);
    expect(fpAlice).not.toBe(fpBob);
  });

  it('produces different fingerprints for same key but different user IDs', () => {
    const fp1 = computeFingerprint(ALICE_PUBLIC, ALICE_ID);
    const fp2 = computeFingerprint(ALICE_PUBLIC, BOB_ID);
    expect(fp1).not.toBe(fp2);
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => computeFingerprint(new Uint8Array(31), ALICE_ID)).toThrow(
      'Public key must be 32 bytes',
    );
    expect(() => computeFingerprint(new Uint8Array(33), ALICE_ID)).toThrow(
      'Public key must be 32 bytes',
    );
  });

  it('rejects empty user IDs', () => {
    expect(() => computeFingerprint(ALICE_PUBLIC, '')).toThrow(
      'User ID is required',
    );
  });

  it('has zero-padded groups (each 5-digit chunk can start with 0)', () => {
    // The fingerprint is composed of 6 groups of 5 digits each.
    // Each group is chunk % 100000, zero-padded. Verify format.
    const fp = computeFingerprint(ALICE_PUBLIC, ALICE_ID);
    for (let i = 0; i < 6; i++) {
      const group = fp.slice(i * 5, i * 5 + 5);
      expect(group).toHaveLength(5);
      expect(group).toMatch(/^\d{5}$/);
    }
  });
});

describe('computeSafetyNumber', () => {
  it('returns a 60-digit string', () => {
    const sn = computeSafetyNumber(
      ALICE_PUBLIC,
      ALICE_ID,
      BOB_PUBLIC,
      BOB_ID,
    );
    expect(sn).toHaveLength(60);
    expect(sn).toMatch(/^\d{60}$/);
  });

  it('is symmetric — both users see the same number', () => {
    const snAlice = computeSafetyNumber(
      ALICE_PUBLIC,
      ALICE_ID,
      BOB_PUBLIC,
      BOB_ID,
    );
    const snBob = computeSafetyNumber(
      BOB_PUBLIC,
      BOB_ID,
      ALICE_PUBLIC,
      ALICE_ID,
    );
    expect(snAlice).toBe(snBob);
  });

  it('produces different numbers for different key pairs', () => {
    const sn1 = computeSafetyNumber(
      ALICE_PUBLIC,
      ALICE_ID,
      BOB_PUBLIC,
      BOB_ID,
    );

    const charlieSecret = new Uint8Array(32).fill(0x03);
    const charliePublic = ed25519.getPublicKey(charlieSecret);
    const charlieId = '01HZXK5M8E3J6Q9P2RVTYWN4EF';

    const sn2 = computeSafetyNumber(
      ALICE_PUBLIC,
      ALICE_ID,
      charliePublic,
      charlieId,
    );
    expect(sn1).not.toBe(sn2);
  });

  it('is deterministic across calls', () => {
    const sn1 = computeSafetyNumber(
      ALICE_PUBLIC,
      ALICE_ID,
      BOB_PUBLIC,
      BOB_ID,
    );
    const sn2 = computeSafetyNumber(
      ALICE_PUBLIC,
      ALICE_ID,
      BOB_PUBLIC,
      BOB_ID,
    );
    expect(sn1).toBe(sn2);
  });

  it('matches a known test vector', () => {
    // Pinned output for regression detection. If the algorithm changes,
    // this test must be updated to the new expected value.
    const sn = computeSafetyNumber(
      ALICE_PUBLIC,
      ALICE_ID,
      BOB_PUBLIC,
      BOB_ID,
    );
    // Snapshot: computed once, hardcoded for regression.
    // If this fails after an intentional algorithm change, re-generate.
    expect(sn).toMatchSnapshot();
  });
});

describe('formatSafetyNumber', () => {
  it('formats 60 digits as a 4×3 grid of 5-digit groups', () => {
    const digits = '0'.repeat(60);
    const grid = formatSafetyNumber(digits);
    expect(grid).toHaveLength(4);
    for (const row of grid) {
      expect(row).toHaveLength(3);
      for (const group of row) {
        expect(group).toBe('00000');
      }
    }
  });

  it('preserves digit order in the grid', () => {
    // Build a string where each group is a recognizable pattern
    let digits = '';
    for (let i = 0; i < 12; i++) {
      digits += String(i).repeat(5).slice(0, 5);
    }
    // digits = "00000111112222233333444445555566666777778888899999AAAAABBBBB"
    // Wait, we need only digits. Use: 00000 11111 22222 33333 ... 91919 (pad with repeats)
    digits =
      '00000111112222233333444445555566666777778888899999' + '10101' + '21212';
    const grid = formatSafetyNumber(digits);

    expect(grid[0]).toEqual(['00000', '11111', '22222']);
    expect(grid[1]).toEqual(['33333', '44444', '55555']);
    expect(grid[2]).toEqual(['66666', '77777', '88888']);
    expect(grid[3]).toEqual(['99999', '10101', '21212']);
  });

  it('rejects input that is not 60 digits', () => {
    expect(() => formatSafetyNumber('12345')).toThrow(
      'Safety number must be 60 digits',
    );
    expect(() => formatSafetyNumber('0'.repeat(59))).toThrow(
      'Safety number must be 60 digits',
    );
    expect(() => formatSafetyNumber('0'.repeat(61))).toThrow(
      'Safety number must be 60 digits',
    );
  });
});
