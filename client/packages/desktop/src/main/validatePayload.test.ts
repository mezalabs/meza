import { describe, expect, it } from 'vitest';
import {
  MAX_BINDINGS,
  MAX_KEYS_LEN,
  validatePayload,
} from './validatePayload.ts';

const validBinding = {
  id: 'search',
  keys: 'mod+k',
  type: 'press' as const,
  isGlobal: true,
};

describe('validatePayload', () => {
  it('accepts an empty array', () => {
    expect(validatePayload([])).toEqual([]);
  });

  it('accepts a single valid binding', () => {
    expect(validatePayload([validBinding])).toEqual([validBinding]);
  });

  it('accepts both press and hold types', () => {
    const ptt = {
      id: 'push-to-mute',
      keys: 'alt+space',
      type: 'hold' as const,
      isGlobal: true,
    };
    expect(validatePayload([validBinding, ptt])).toEqual([validBinding, ptt]);
  });

  describe('rejects', () => {
    it('non-array', () => {
      expect(validatePayload(null)).toBeNull();
      expect(validatePayload(undefined)).toBeNull();
      expect(validatePayload('not an array')).toBeNull();
      expect(validatePayload({})).toBeNull();
      expect(validatePayload(42)).toBeNull();
    });

    it('oversize array (DoS guard)', () => {
      const huge = Array.from({ length: MAX_BINDINGS + 1 }, () => validBinding);
      expect(validatePayload(huge)).toBeNull();
    });

    it('non-object item', () => {
      expect(validatePayload([null])).toBeNull();
      expect(validatePayload(['string'])).toBeNull();
      expect(validatePayload([42])).toBeNull();
    });

    it('unknown id', () => {
      expect(
        validatePayload([{ ...validBinding, id: 'definitely-not-a-keybind' }]),
      ).toBeNull();
    });

    it('non-string id', () => {
      expect(validatePayload([{ ...validBinding, id: 42 }])).toBeNull();
      expect(
        validatePayload([{ ...validBinding, id: undefined }]),
      ).toBeNull();
    });

    it('non-string keys', () => {
      expect(validatePayload([{ ...validBinding, keys: 42 }])).toBeNull();
    });

    it('oversize keys (DoS guard)', () => {
      expect(
        validatePayload([{ ...validBinding, keys: 'x'.repeat(MAX_KEYS_LEN + 1) }]),
      ).toBeNull();
    });

    it('invalid type literal', () => {
      expect(validatePayload([{ ...validBinding, type: 'click' }])).toBeNull();
      expect(validatePayload([{ ...validBinding, type: 1 }])).toBeNull();
      expect(
        validatePayload([{ ...validBinding, type: undefined }]),
      ).toBeNull();
    });

    it('non-boolean isGlobal', () => {
      expect(
        validatePayload([{ ...validBinding, isGlobal: 'yes' }]),
      ).toBeNull();
      expect(validatePayload([{ ...validBinding, isGlobal: 1 }])).toBeNull();
      expect(
        validatePayload([{ ...validBinding, isGlobal: undefined }]),
      ).toBeNull();
    });

    it('mixed valid+invalid → whole array dropped', () => {
      expect(
        validatePayload([validBinding, { ...validBinding, id: 'bogus' }]),
      ).toBeNull();
    });
  });
});
