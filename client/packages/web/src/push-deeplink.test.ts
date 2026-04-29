import { describe, expect, it } from 'vitest';
import { buildPushDeepLink, parsePushDeepLink } from './push-deeplink.ts';

describe('buildPushDeepLink', () => {
  it('builds a channel URL without user_id', () => {
    expect(buildPushDeepLink({ kind: 'channel', channelId: 'c_42' })).toBe(
      'meza://channel/c_42',
    );
  });

  it('builds a DM URL with user_id query param', () => {
    expect(
      buildPushDeepLink({
        kind: 'dm',
        channelId: 'c_dm',
        userId: 'u_recipient',
      }),
    ).toBe('meza://dm/c_dm?user_id=u_recipient');
  });
});

describe('parsePushDeepLink', () => {
  it('parses a channel URL', () => {
    expect(
      parsePushDeepLink('meza://channel/c_42?user_id=u_recipient'),
    ).toEqual({ kind: 'channel', channelId: 'c_42', userId: 'u_recipient' });
  });

  it('parses a DM URL', () => {
    expect(parsePushDeepLink('meza://dm/c_dm?user_id=u_recipient')).toEqual({
      kind: 'dm',
      channelId: 'c_dm',
      userId: 'u_recipient',
    });
  });

  it('parses a URL with no query string', () => {
    expect(parsePushDeepLink('meza://channel/c_42')).toEqual({
      kind: 'channel',
      channelId: 'c_42',
      userId: undefined,
    });
  });

  it('returns null for non-matching URLs', () => {
    expect(parsePushDeepLink('meza://i/example.com/abc?s=secret')).toBeNull();
    expect(parsePushDeepLink('https://example.com')).toBeNull();
    expect(parsePushDeepLink('meza://other/foo')).toBeNull();
  });

  it('rejects channel IDs with disallowed characters', () => {
    expect(parsePushDeepLink('meza://dm/c.42')).toBeNull();
    expect(parsePushDeepLink('meza://dm/c/42')).toBeNull();
  });

  it('bounds an excessively long query string without crashing', () => {
    const huge = 'x'.repeat(50_000);
    const got = parsePushDeepLink(`meza://dm/c_42?user_id=${huge}`);
    expect(got).not.toBeNull();
    expect(got?.userId?.length).toBeLessThanOrEqual(1024);
  });
});

describe('round-trip', () => {
  it('parse(build(d)) === d for typical inputs', () => {
    const cases = [
      { kind: 'channel' as const, channelId: 'c_42', userId: 'u_recipient' },
      { kind: 'dm' as const, channelId: 'c_dm', userId: 'u_recipient' },
      { kind: 'channel' as const, channelId: 'c_42', userId: undefined },
    ];
    for (const d of cases) {
      const url = buildPushDeepLink(d);
      const parsed = parsePushDeepLink(url);
      expect(parsed).toEqual(d);
    }
  });
});
