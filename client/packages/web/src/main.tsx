import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './index.css';

import {
  bootstrapSession,
  gatewayConnect,
  gatewayDisconnect,
  isCapacitor,
  isElectron,
  isSessionReady,
  onCrossTabTeardown,
  onSessionReady,
  subscribeToPush,
  teardownSession,
  useAuthStore,
  useInviteStore,
} from '@meza/core';
import { InviteLanding, LandingPage, Shell, TitleBar } from '@meza/ui';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { navigateToChannel } from './navigate.ts';

// One-time migration: clear stale anonymous sessions from localStorage.
// Previous versions stored anonymous user sessions that are no longer valid.
const storedAuth = localStorage.getItem('meza-auth');
if (storedAuth) {
  try {
    const parsed = JSON.parse(storedAuth);
    if (parsed?.state?.user?.isAnonymous) {
      localStorage.removeItem('meza-auth');
    }
  } catch {
    // Ignore parse errors — localStorage may be corrupted.
  }
}

// Parse /invite/{code} from the current URL and store it before React renders.
const inviteMatch = window.location.pathname.match(
  /^\/invite\/([a-z0-9]{8})$/i,
);
if (inviteMatch) {
  useInviteStore.getState().setPendingCode(inviteMatch[1]?.toLowerCase() ?? '');
  // Capture fragment (invite secret for E2EE key bundle) — never sent to server
  const fragment = window.location.hash.slice(1); // strip '#'
  if (fragment) {
    useInviteStore.getState().setInviteSecret(fragment);
  }
  history.replaceState(null, '', '/');
}

// Connect/disconnect gateway based on auth state — outside React to avoid StrictMode double-mount.
// Handle the case where the page reloads with an already-authenticated state from localStorage.
const initialAuth = useAuthStore.getState();
const { accessToken } = initialAuth;
if (initialAuth.isAuthenticated && accessToken) {
  // Bootstrap E2EE session before connecting the gateway. If sessionStorage
  // is empty (new tab), bootstrapSession will request the session key from
  // another open tab via BroadcastChannel. If no tab responds (all closed),
  // bootstrap fails and we clear auth to force re-login — otherwise the
  // chat UI renders but cannot decrypt any messages.
  bootstrapSession()
    .then((ok) => {
      if (ok) {
        gatewayConnect(accessToken);
      } else if (useAuthStore.getState().isAuthenticated) {
        useAuthStore.getState().clearAuth();
      }
    })
    .catch(() => {
      useAuthStore.getState().clearAuth();
    });
}

useAuthStore.subscribe((state, prevState) => {
  if (
    state.isAuthenticated &&
    state.accessToken &&
    !prevState.isAuthenticated
  ) {
    gatewayConnect(state.accessToken);
  } else if (!state.isAuthenticated && prevState.isAuthenticated) {
    gatewayDisconnect();
    teardownSession();
  }
});

// Cross-tab logout: when another tab tears down its session (logout),
// clear auth locally so this tab also logs out.
onCrossTabTeardown(() => {
  useAuthStore.getState().clearAuth();
});

// Initialize Capacitor when running inside a native shell.
if (isCapacitor()) {
  import('./capacitor-init.ts')
    .then(({ initCapacitor }) => initCapacitor())
    .catch((err) => console.error('Capacitor init failed:', err));
} else if (!isElectron()) {
  // Web: register for push notifications.
  import('./push-adapter.ts').then(({ WebPushAdapter }) => {
    const adapter = new WebPushAdapter();
    if (useAuthStore.getState().isAuthenticated) {
      subscribeToPush(adapter).catch((err) =>
        console.error('Push subscription failed:', err),
      );
    }
    useAuthStore.subscribe((state, prevState) => {
      if (state.isAuthenticated && !prevState.isAuthenticated) {
        subscribeToPush(adapter).catch((err) =>
          console.error('Push subscription failed:', err),
        );
      }
    });
  });
}

// Handle PUSH_NAVIGATE messages from the push service worker (web).
navigator.serviceWorker?.addEventListener('message', (event) => {
  if (event.data?.type === 'PUSH_NAVIGATE' && event.data.channelId) {
    navigateToChannel(event.data.channelId);
  }
});

function App() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const hasPendingInvite = useInviteStore((s) => !!s.pendingCode);

  // Wait for the E2EE session to be ready before rendering Shell.
  // This prevents a brief flash of the chat UI that immediately vanishes
  // when bootstrap fails (e.g. new tab with no peer to share session key).
  const [sessionReady, setSessionReady] = useState(isSessionReady());
  useEffect(() => {
    if (sessionReady) return;
    return onSessionReady(() => setSessionReady(true));
  }, [sessionReady]);

  // If authenticated but session hasn't become ready after a timeout,
  // something went wrong (e.g. crypto bootstrap failed silently). Force
  // re-login so the user isn't stuck on a blank screen.
  useEffect(() => {
    if (sessionReady || !isAuthenticated) return;
    // Longer timeout on mobile — IndexedDB can be slower on Android WebViews
    const timeoutMs = isCapacitor() ? 15_000 : 8_000;
    const timer = setTimeout(() => {
      if (!isSessionReady()) {
        console.warn(
          '[Meza] E2EE session bootstrap timed out — clearing auth to force re-login',
        );
        useAuthStore
          .getState()
          .setError('Session setup timed out. Please sign in again.');
        useAuthStore.getState().clearAuth();
      }
    }, timeoutMs);
    return () => clearTimeout(timer);
  }, [sessionReady, isAuthenticated]);

  let content: React.ReactNode;
  if (isAuthenticated && sessionReady) content = <Shell />;
  else if (hasPendingInvite) content = <InviteLanding />;
  else if (!isAuthenticated) content = <LandingPage />;
  else {
    // Authenticated but session not ready yet — show a loading state
    content = (
      <div className="flex flex-1 items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-current border-t-transparent text-text-muted" />
          <span className="text-sm text-text-muted">
            Setting up encryption…
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh w-screen flex-col overflow-hidden">
      <TitleBar />
      {content}
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<App />);
}
