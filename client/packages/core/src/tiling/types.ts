export type PaneId = string;

export type SplitDirection = 'horizontal' | 'vertical';

export type TreePath = ('first' | 'second')[];

export type PaneContent =
  | { type: 'channel'; channelId: string }
  | { type: 'dm'; conversationId: string }
  | { type: 'voice'; channelId: string }
  | {
      type: 'screenShare';
      channelId: string;
      participantIdentity: string;
      participantName?: string;
    }
  | { type: 'settings'; section?: string }
  | { type: 'profile'; userId: string; editing?: boolean }
  | { type: 'search'; query?: string; channelId?: string }
  | { type: 'serverSettings'; serverId: string }
  | { type: 'channelSettings'; serverId: string; channelId: string }
  | { type: 'serverOnboarding'; serverId: string }
  | { type: 'getStarted' }
  | { type: 'createServer' }
  | { type: 'messageRequests' }
  | { type: 'friends'; tab?: 'all' | 'pending' | 'add' }
  | { type: 'empty' };

export interface PaneLeaf {
  type: 'pane';
  id: PaneId;
}

export interface PaneSplit {
  type: 'split';
  direction: SplitDirection;
  /** Proportion of the first child's size (0.1 – 0.9) */
  ratio: number;
  first: TilingNode;
  second: TilingNode;
}

export type TilingNode = PaneLeaf | PaneSplit;

export type DropPosition = 'center' | 'left' | 'right' | 'top' | 'bottom';
