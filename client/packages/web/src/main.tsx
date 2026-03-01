import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './index.css';

import {
  bootstrapSession,
  flushChannelKeys,
  gatewayConnect,
  gatewayDisconnect,
  teardownSession,
  useAuthStore,
  useInviteStore,
} from '@meza/core';
import { InviteLanding, LandingPage, Shell, TitleBar } from '@meza/ui';
import { createRoot } from 'react-dom/client';

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
  history.replaceState(null, '', '/');
}

// Connect/disconnect gateway based on auth state — outside React to avoid StrictMode double-mount.
// Handle the case where the page reloads with an already-authenticated state from localStorage.
const initialAuth = useAuthStore.getState();
if (initialAuth.isAuthenticated && initialAuth.accessToken) {
  gatewayConnect(initialAuth.accessToken);
  // Bootstrap E2EE session from IndexedDB (async, non-blocking)
  bootstrapSession();
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

// Flush channel keys to IndexedDB on tab hide or close.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushChannelKeys();
});
window.addEventListener('beforeunload', () => {
  flushChannelKeys();
});

function App() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const hasPendingInvite = useInviteStore((s) => !!s.pendingCode);

  let content: React.ReactNode;
  if (isAuthenticated) content = <Shell />;
  else if (hasPendingInvite) content = <InviteLanding />;
  else content = <LandingPage />;

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
