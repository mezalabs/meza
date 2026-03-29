export interface DemoUser {
  name: string;
  avatarUrl?: string;
  avatarColor: string;
  presence: 'online' | 'idle' | 'offline';
}

export interface DemoServer {
  id: string;
  name: string;
  iconLetter?: string;
  unread?: boolean;
}

export interface DemoChannel {
  id: string;
  name: string;
  type: 'text' | 'voice';
  unread?: boolean;
}

export interface DemoReaction {
  emoji: string;
  count: number;
  reacted?: boolean;
}

export interface DemoMessage {
  id: string;
  author: DemoUser;
  timestamp: string;
  content: string;
  reactions?: DemoReaction[];
}

export interface DemoVoiceParticipant {
  user: DemoUser;
  muted: boolean;
  speaking: boolean;
}

export interface DemoSettingsSection {
  id: string;
  label: string;
}

export interface DemoScenario {
  servers: DemoServer[];
  channels: DemoChannel[];
  activeServerId: string;
  activeChannelId: string;
  messages: Record<string, DemoMessage[]>;
  members: DemoUser[];
  typingUser?: string;
}
