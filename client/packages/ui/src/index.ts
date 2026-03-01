export { MEZA_VERSION } from '@meza/core';
export { ChannelView } from './components/chat/ChannelView.tsx';
// Landing page components
export { InviteLanding } from './components/lobby/InviteLanding.tsx';
export { LandingPage } from './components/lobby/LandingPage.tsx';
export { SettingsView } from './components/settings/SettingsView.tsx';
export { ContentArea } from './components/shell/ContentArea.tsx';
export { Pane } from './components/shell/Pane.tsx';
export { ResizeHandle } from './components/shell/ResizeHandle.tsx';
// Shell components
export { Shell } from './components/shell/Shell.tsx';
export { Sidebar } from './components/shell/Sidebar.tsx';
export { TilingRenderer } from './components/shell/TilingRenderer.tsx';
export { TitleBar } from './components/shell/TitleBar.tsx';
export type {
  NavigationActions,
  NavigationState,
} from './stores/navigation.ts';
export { useNavigationStore } from './stores/navigation.ts';
export type { TilingActions, TilingState } from './stores/tiling.ts';
// Stores
export { useTilingStore } from './stores/tiling.ts';
