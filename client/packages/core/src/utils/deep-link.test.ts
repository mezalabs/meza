import { describe, expect, it } from 'vitest';
import { buildDeepLinkUrl, parseDeepLink } from './deep-link.ts';

describe('buildDeepLinkUrl', () => {
  it('builds a URL with no secret', () => {
    expect(buildDeepLinkUrl({ host: 'meza.chat', code: 'abc12345' })).toBe(
      'meza://i/meza.chat/abc12345',
    );
  });

  it('puts the secret in the URL fragment', () => {
    const secret = 'AAAA-BBBB_CCCC';
    expect(
      buildDeepLinkUrl({ host: 'meza.chat', code: 'abc12345', secret }),
    ).toBe(`meza://i/meza.chat/abc12345#${secret}`);
  });
});

describe('parseDeepLink', () => {
  it('rejects unrecognized prefixes', () => {
    expect(parseDeepLink('https://meza.chat/invite/abc12345')).toBeNull();
    expect(parseDeepLink('meza://app/index.html')).toBeNull();
  });

  it('rejects invalid hosts and codes', () => {
    expect(parseDeepLink('meza://i//abc12345')).toBeNull();
    expect(parseDeepLink('meza://i/meza.chat/short')).toBeNull();
    expect(parseDeepLink('meza://i/-bad-/abc12345')).toBeNull();
  });

  it('parses host + code with no secret', () => {
    expect(parseDeepLink('meza://i/meza.chat/abc12345')).toEqual({
      host: 'meza.chat',
      code: 'abc12345',
      secret: undefined,
    });
  });

  it('parses fragment-form secrets (current format)', () => {
    expect(parseDeepLink('meza://i/meza.chat/abc12345#deadbeef_xyz')).toEqual({
      host: 'meza.chat',
      code: 'abc12345',
      secret: 'deadbeef_xyz',
    });
  });

  it('still parses legacy ?s= query-form secrets', () => {
    expect(parseDeepLink('meza://i/meza.chat/abc12345?s=deadbeef_xyz')).toEqual(
      {
        host: 'meza.chat',
        code: 'abc12345',
        secret: 'deadbeef_xyz',
      },
    );
  });

  it('round-trips through buildDeepLinkUrl', () => {
    const original = {
      host: 'self.example.com',
      code: 'aabb1122',
      secret: 'random-base64url-secret',
    };
    expect(parseDeepLink(buildDeepLinkUrl(original))).toEqual(original);
  });
});
