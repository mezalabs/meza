import type { PaneContent } from '@meza/core';

export type DemoPaneId = 'welcome' | 'features' | 'getStarted';

export const DEMO_CHANNELS: { id: DemoPaneId; name: string }[] = [
  { id: 'welcome', name: 'welcome' },
  { id: 'features', name: 'features' },
  { id: 'getStarted', name: 'get-started' },
];

/** Map demo channel IDs to PaneContent values for the tiling store. */
export const DEMO_CHANNEL_IDS: Record<DemoPaneId, string> = {
  welcome: 'demo-welcome',
  features: 'demo-features',
  getStarted: 'demo-get-started',
};

/** Build a PaneContent for a demo channel. */
export function demoPaneContent(id: DemoPaneId): PaneContent {
  return { type: 'channel', channelId: DEMO_CHANNEL_IDS[id] };
}

/** Reverse-map a PaneContent channelId back to a DemoPaneId. */
export function demoPaneIdFromContent(
  content: PaneContent | undefined,
): DemoPaneId {
  if (content?.type === 'channel') {
    for (const [demoId, channelId] of Object.entries(DEMO_CHANNEL_IDS)) {
      if (content.channelId === channelId) return demoId as DemoPaneId;
    }
  }
  return 'welcome';
}
