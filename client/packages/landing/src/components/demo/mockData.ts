import type {
  DemoChannel,
  DemoMessage,
  DemoScenario,
  DemoServer,
  DemoSettingsSection,
  DemoUser,
  DemoVoiceParticipant,
} from './types';

// ── Users ──

const alice: DemoUser = {
  name: 'Alice',
  avatarColor: '#6affb0',
  presence: 'online',
};
const bob: DemoUser = {
  name: 'Bob',
  avatarColor: '#3bacda',
  presence: 'online',
};
const carol: DemoUser = {
  name: 'Carol',
  avatarColor: '#d9a514',
  presence: 'idle',
};
const dave: DemoUser = {
  name: 'Dave',
  avatarColor: '#f14d4c',
  presence: 'online',
};
const eve: DemoUser = {
  name: 'Eve',
  avatarColor: '#b07aff',
  presence: 'offline',
};

// ── Servers ──

const servers: DemoServer[] = [
  { id: 'meza', name: 'Meza Community', iconLetter: 'M', unread: true },
  { id: 'design', name: 'Design Team', iconLetter: 'D' },
  { id: 'oss', name: 'Open Source', iconLetter: 'O' },
];

// ── Channels ──

const channels: DemoChannel[] = [
  { id: 'general', name: 'general', type: 'text' },
  { id: 'announcements', name: 'announcements', type: 'text', unread: true },
  { id: 'development', name: 'development', type: 'text' },
  { id: 'voice-chat', name: 'voice-chat', type: 'voice' },
];

// ── Messages ──

const generalMessages: DemoMessage[] = [
  {
    id: '1',
    author: alice,
    timestamp: '2:34 PM',
    content: "The E2E encryption is seamless — I can't even tell it's there.",
  },
  {
    id: '2',
    author: bob,
    timestamp: '2:36 PM',
    content:
      'Voice channels sound great too. Crystal clear audio even on a VPN.',
    reactions: [
      { emoji: '👍', count: 3, reacted: true },
      { emoji: '🔥', count: 1 },
    ],
  },
  {
    id: '3',
    author: carol,
    timestamp: '2:38 PM',
    content:
      'Just self-hosted on my own server. Docker Compose made it so easy.',
  },
  {
    id: '4',
    author: dave,
    timestamp: '2:40 PM',
    content:
      'The markdown support is nice — **bold**, `inline code`, and even code blocks work.',
  },
  {
    id: '5',
    author: alice,
    timestamp: '2:42 PM',
    content:
      'Has anyone tried the thread feature? It keeps conversations organized without cluttering the main channel.',
    reactions: [{ emoji: '❤️', count: 2 }],
  },
  {
    id: '6',
    author: bob,
    timestamp: '2:44 PM',
    content:
      "Love that it's fully open source. I audited the crypto implementation myself.",
  },
];

const devMessages: DemoMessage[] = [
  {
    id: 'd1',
    author: dave,
    timestamp: '11:20 AM',
    content: 'Pushed the new role permissions UI. Can someone review?',
  },
  {
    id: 'd2',
    author: alice,
    timestamp: '11:22 AM',
    content: 'On it! The permission matrix looks clean.',
    reactions: [{ emoji: '🚀', count: 1 }],
  },
  {
    id: 'd3',
    author: bob,
    timestamp: '11:25 AM',
    content:
      'The Go microservices make the backend so fast. Sub-10ms response times.',
  },
  {
    id: 'd4',
    author: carol,
    timestamp: '11:30 AM',
    content: 'Merged! Great work on the RBAC system.',
  },
];

// ── Chat Scenario ──

export const chatScenario: DemoScenario = {
  servers,
  channels,
  activeServerId: 'meza',
  activeChannelId: 'general',
  messages: {
    general: generalMessages,
    development: devMessages,
    announcements: [
      {
        id: 'a1',
        author: alice,
        timestamp: '10:00 AM',
        content:
          '🎉 Meza v0.4.0 is live! New features: thread replies, emoji reactions, and improved voice quality.',
        reactions: [
          { emoji: '🎉', count: 5, reacted: true },
          { emoji: '❤️', count: 3 },
        ],
      },
    ],
  },
  members: [alice, bob, carol, dave, eve],
  typingUser: 'Carol',
};

// ── Voice Scenario ──

export const voiceParticipants: DemoVoiceParticipant[] = [
  { user: alice, muted: false, speaking: true },
  { user: bob, muted: false, speaking: false },
  { user: dave, muted: true, speaking: false },
  { user: carol, muted: false, speaking: false },
];

// ── DM Scenario ──

export const dmMessages: DemoMessage[] = [
  {
    id: 'dm1',
    author: bob,
    timestamp: '3:10 PM',
    content: 'Hey, did you see the new encryption benchmarks?',
  },
  {
    id: 'dm2',
    author: alice,
    timestamp: '3:12 PM',
    content: 'Yes! MLS group ratcheting is impressively fast.',
  },
  {
    id: 'dm3',
    author: bob,
    timestamp: '3:13 PM',
    content:
      'And the best part — forward secrecy means even if a key is compromised, past messages stay safe.',
  },
  {
    id: 'dm4',
    author: alice,
    timestamp: '3:15 PM',
    content: "That's the beauty of the protocol. Each epoch gets fresh keys.",
  },
  {
    id: 'dm5',
    author: bob,
    timestamp: '3:16 PM',
    content: 'Want to hop on a voice call to discuss the implementation?',
    reactions: [{ emoji: '👍', count: 1, reacted: true }],
  },
];

// ── Settings Sections ──

export const settingsSections: DemoSettingsSection[] = [
  { id: 'account', label: 'Account' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'sounds', label: 'Sounds' },
  { id: 'keybinds', label: 'Keybinds' },
];
