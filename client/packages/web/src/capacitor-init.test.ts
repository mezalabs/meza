import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Module-level mock state, mutated per test ---
let sessionReady = false;
let authState: { isAuthenticated: boolean; accessToken: string };

// Queue of pending bootstrapSession resolvers so a test can control exactly
// when each in-flight bootstrap settles (and in what order relative to other
// lifecycle events). Index 0 is the first call, 1 the second, etc.
let bootstrapResolvers: Array<(ok: boolean) => void>;

const gatewayConnect = vi.fn();
const gatewayDisconnect = vi.fn();
const bootstrapSession = vi.fn();
const clearAuth = vi.fn();

vi.mock('@meza/core', () => ({
  applyDeepLinkInvite: vi.fn(),
  bootstrapSession: () => bootstrapSession(),
  CapacitorBadgeAdapter: class {},
  gatewayConnect: (token: string) => gatewayConnect(token),
  gatewayDisconnect: (opts?: { preserveReconnect?: boolean }) =>
    gatewayDisconnect(opts),
  isSessionReady: () => sessionReady,
  parseDeepLink: vi.fn(),
  startBadgeSync: vi.fn(),
  stopBadgeSync: vi.fn(),
  subscribeToPush: vi.fn(),
  useAuthStore: {
    getState: () => ({ ...authState, clearAuth }),
  },
}));

// Stub the push adapter so importing capacitor-init.ts doesn't pull in
// @capacitor/core / @capacitor/push-notifications at module load.
vi.mock('./capacitor-push-adapter.ts', () => ({
  CapacitorPushAdapter: class {
    onNotificationTap() {}
  },
}));

vi.mock('./navigate.ts', () => ({
  navigateFromPush: vi.fn(),
}));

import { setupAppLifecycle } from './capacitor-init.ts';

type StateChangeHandler = (state: { isActive: boolean }) => unknown;

/**
 * A minimal fake of @capacitor/app's `App` that captures the appStateChange
 * listener so a test can drive foreground/background transitions directly.
 * `fire(isActive)` returns the handler's promise so the test can await the
 * async resume logic (including the parked bootstrapSession continuation).
 */
function makeFakeApp() {
  let handler: StateChangeHandler | undefined;
  const App = {
    addListener: vi.fn((event: string, cb: StateChangeHandler) => {
      if (event === 'appStateChange') handler = cb;
      return Promise.resolve({ remove: vi.fn() });
    }),
  };
  return {
    App: App as unknown as typeof import('@capacitor/app').App,
    fire: (isActive: boolean): Promise<unknown> =>
      Promise.resolve(handler?.({ isActive })),
  };
}

describe('setupAppLifecycle — resume/background race', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionReady = false;
    authState = { isAuthenticated: true, accessToken: 'tok' };
    bootstrapResolvers = [];
    bootstrapSession.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          bootstrapResolvers.push(resolve);
        }),
    );
  });

  it('does NOT connect when the app backgrounds mid-bootstrap (the race)', async () => {
    const { App, fire } = makeFakeApp();
    setupAppLifecycle(App);

    // 1) Foreground: session not ready → bootstrapSession starts and parks on
    //    its await. No socket yet.
    const resume = fire(true);
    expect(bootstrapSession).toHaveBeenCalledTimes(1);
    expect(gatewayConnect).not.toHaveBeenCalled();

    // 2) Background again before bootstrap resolves → the disconnect path runs
    //    to completion synchronously.
    await fire(false);
    expect(gatewayDisconnect).toHaveBeenCalledTimes(1);

    // 3) Bootstrap finally resolves → the parked resume wakes.
    bootstrapResolvers[0](true);
    await resume;

    // The stale resume must NOT open a socket on the now-backgrounded app.
    expect(gatewayConnect).not.toHaveBeenCalled();
  });

  it('connects on resume when bootstrap completes uninterrupted', async () => {
    const { App, fire } = makeFakeApp();
    setupAppLifecycle(App);

    const resume = fire(true);
    bootstrapResolvers[0](true);
    await resume;

    expect(gatewayConnect).toHaveBeenCalledTimes(1);
    expect(gatewayConnect).toHaveBeenCalledWith('tok');
  });

  it('connects without bootstrapping when the session is already ready', async () => {
    sessionReady = true;
    const { App, fire } = makeFakeApp();
    setupAppLifecycle(App);

    await fire(true);

    expect(bootstrapSession).not.toHaveBeenCalled();
    expect(gatewayConnect).toHaveBeenCalledWith('tok');
  });

  it('pauses with preserveReconnect on background', async () => {
    const { App, fire } = makeFakeApp();
    setupAppLifecycle(App);

    await fire(false);

    expect(gatewayDisconnect).toHaveBeenCalledWith({ preserveReconnect: true });
    expect(gatewayConnect).not.toHaveBeenCalled();
  });

  it('clears auth when bootstrap fails and the resume is still current', async () => {
    const { App, fire } = makeFakeApp();
    setupAppLifecycle(App);

    const resume = fire(true);
    bootstrapResolvers[0](false);
    await resume;

    expect(clearAuth).toHaveBeenCalledTimes(1);
    expect(gatewayConnect).not.toHaveBeenCalled();
  });

  it('does NOT clear auth when a failed bootstrap was superseded by a background', async () => {
    const { App, fire } = makeFakeApp();
    setupAppLifecycle(App);

    const resume = fire(true);
    await fire(false); // supersede the parked resume
    bootstrapResolvers[0](false);
    await resume;

    // The newer (background) invocation owns the current state; the stale
    // resume must not tear down auth on its behalf.
    expect(clearAuth).not.toHaveBeenCalled();
    expect(gatewayConnect).not.toHaveBeenCalled();
  });

  it('ignores lifecycle events entirely when unauthenticated', async () => {
    authState = { isAuthenticated: false, accessToken: '' };
    const { App, fire } = makeFakeApp();
    setupAppLifecycle(App);

    await fire(true);
    await fire(false);

    expect(bootstrapSession).not.toHaveBeenCalled();
    expect(gatewayConnect).not.toHaveBeenCalled();
    expect(gatewayDisconnect).not.toHaveBeenCalled();
  });

  it('connects once for the latest resume after a background between two foregrounds', async () => {
    const { App, fire } = makeFakeApp();
    setupAppLifecycle(App);

    const resume1 = fire(true); // gen 1, bootstrap[0] in flight
    await fire(false); // gen 2, disconnect
    const resume2 = fire(true); // gen 3, bootstrap[1] in flight
    expect(bootstrapSession).toHaveBeenCalledTimes(2);

    // Resolve the stale (gen 1) bootstrap first — must NOT connect.
    bootstrapResolvers[0](true);
    await resume1;
    expect(gatewayConnect).not.toHaveBeenCalled();

    // Resolve the current (gen 3) bootstrap — connects exactly once.
    bootstrapResolvers[1](true);
    await resume2;
    expect(gatewayConnect).toHaveBeenCalledTimes(1);
    expect(gatewayConnect).toHaveBeenCalledWith('tok');
  });
});
