import { useEffect, useRef } from 'react';
import { useNavigationStore } from '../stores/navigation.ts';

/**
 * Syncs mobile navigation state with the browser history stack.
 * Pushes synthetic history entries when navigating into channel view,
 * overlays, or voice fullscreen. Listens for `popstate` to dismiss them,
 * making the Android back button and browser back work correctly.
 */
export function useMobileHistory(): void {
  const mobileActiveChannel = useNavigationStore((s) => s.mobileActiveChannel);
  const mobileOverlay = useNavigationStore((s) => s.mobileOverlay);
  const mobileVoiceFullscreen = useNavigationStore(
    (s) => s.mobileVoiceFullscreen,
  );
  const closeMobileChannel = useNavigationStore((s) => s.closeMobileChannel);
  const closeMobileOverlay = useNavigationStore((s) => s.closeMobileOverlay);
  const closeMobileVoice = useNavigationStore((s) => s.closeMobileVoice);

  // Track the depth we've pushed so we don't double-push
  const depthRef = useRef(0);

  // Compute target depth based on current mobile nav state
  const targetDepth =
    (mobileActiveChannel ? 1 : 0) +
    (mobileVoiceFullscreen ? 1 : 0) +
    (mobileOverlay ? 1 : 0);

  // Push/pop history entries to match target depth
  useEffect(() => {
    while (depthRef.current < targetDepth) {
      history.pushState({ mobileNav: depthRef.current + 1 }, '');
      depthRef.current++;
    }
    // If depth decreased, we don't need to pop — the popstate handler already did
  }, [targetDepth]);

  // Handle popstate (Android back / browser back)
  useEffect(() => {
    function handlePopState(_e: PopStateEvent) {
      if (depthRef.current <= 0) return;
      depthRef.current--;

      // Dismiss in priority order: overlay → voice → channel
      const state = useNavigationStore.getState();
      if (state.mobileOverlay) {
        closeMobileOverlay();
      } else if (state.mobileVoiceFullscreen) {
        closeMobileVoice();
      } else if (state.mobileActiveChannel) {
        closeMobileChannel();
      }
    }

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [closeMobileChannel, closeMobileOverlay, closeMobileVoice]);
}
