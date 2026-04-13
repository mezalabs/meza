import {
  buildMessageContent,
  buildContextAAD,
  PURPOSE_MESSAGE,
  signMessage,
  encryptPayload,
} from '../lib/crypto.ts';
import type { SeedConfig } from '../lib/config.ts';
import { createChatClient } from '../lib/rpc.ts';
import { log, logIndent } from '../lib/log.ts';
import type { SeededUser } from './users.ts';
import type { ChannelKeyInfo } from './channel-keys.ts';

const SIGNATURE_SIZE = 64;

interface MessageScript {
  sender: string;
  text: string;
  replyToIndex?: number;
  reactions?: Array<{ user: string; emoji: string }>;
}

interface ChannelConversation {
  channelId: string;
  channelName: string;
  messages: MessageScript[];
}

/**
 * Build conversation scripts for all seeded channels.
 */
export function getConversations(channelIds: {
  s1General: string;
  s1Random: string;
  s2General: string;
}): ChannelConversation[] {
  return [
    {
      channelId: channelIds.s1General,
      channelName: '#general (Meza Dev)',
      messages: [
        { sender: 'alice', text: 'Welcome to Meza Dev! This is the general channel.' },
        { sender: 'bob', text: 'Hey everyone! Glad to be here.' },
        { sender: 'charlie', text: 'This is exciting, the E2EE seems to work really well.' },
        { sender: 'alice', text: 'Yeah, all messages are encrypted with per-channel keys.', replyToIndex: 2 },
        { sender: 'bob', text: 'I pushed a fix for the voice chat issue earlier today.' },
        { sender: 'charlie', text: 'Nice work!', replyToIndex: 4, reactions: [{ user: 'alice', emoji: '🎉' }] },
        { sender: 'alice', text: 'Has anyone tested the mobile build lately?' },
        { sender: 'bob', text: 'I ran it yesterday, everything looks good on Android.', reactions: [{ user: 'alice', emoji: '👍' }, { user: 'charlie', emoji: '👍' }] },
        { sender: 'charlie', text: 'iOS too, no issues on my end.' },
      ],
    },
    {
      channelId: channelIds.s1Random,
      channelName: '#random (Meza Dev)',
      messages: [
        { sender: 'bob', text: 'Anyone else having trouble with their dev environment today?' },
        { sender: 'alice', text: 'Mine is fine. Did you try restarting the services?' },
        { sender: 'bob', text: 'Yeah that fixed it, thanks!' },
        { sender: 'charlie', text: 'Classic. Have you tried turning it off and on again?' },
        { sender: 'alice', text: 'Works every time 😄', reactions: [{ user: 'bob', emoji: '😂' }] },
      ],
    },
    {
      channelId: channelIds.s2General,
      channelName: '#general (Test Server)',
      messages: [
        { sender: 'bob', text: 'Welcome to the Test Server! Feel free to experiment here.' },
        { sender: 'alice', text: 'Thanks for setting this up, Bob.' },
        { sender: 'bob', text: 'No problem! Let me know if you need any channels added.' },
      ],
    },
  ];
}

/**
 * Build DM conversation scripts.
 */
export function getDMConversations(dmChannels: {
  aliceBob: string;
  aliceCharlie: string;
}): ChannelConversation[] {
  return [
    {
      channelId: dmChannels.aliceBob,
      channelName: 'DM: alice <-> bob',
      messages: [
        { sender: 'alice', text: 'Hey Bob, do you have a minute?' },
        { sender: 'bob', text: 'Sure, what is it?' },
        { sender: 'alice', text: 'I wanted to discuss the new permission system.' },
        { sender: 'bob', text: 'Good idea. I think we should simplify the role hierarchy.' },
        { sender: 'alice', text: 'Agreed. Let me draft a proposal and share it tomorrow.' },
        { sender: 'bob', text: 'Sounds good! 👍' },
      ],
    },
    {
      channelId: dmChannels.aliceCharlie,
      channelName: 'DM: alice <-> charlie',
      messages: [
        { sender: 'alice', text: 'Hey Charlie, welcome to the team!' },
        { sender: 'charlie', text: 'Thanks Alice! Happy to be here.' },
        { sender: 'alice', text: 'Let me know if you need help getting set up.' },
      ],
    },
  ];
}

/**
 * Encrypt and send messages for a list of channel conversations.
 * Returns sent message IDs keyed by channelId for reaction seeding.
 */
export async function seedMessages(
  config: SeedConfig,
  conversations: ChannelConversation[],
  users: Record<string, SeededUser>,
  channelKeys: Map<string, ChannelKeyInfo>,
): Promise<void> {
  log('Sending messages...');

  for (const conv of conversations) {
    const keyInfo = channelKeys.get(conv.channelId);
    if (!keyInfo) {
      throw new Error(`No channel key for ${conv.channelId}`);
    }

    const sentMessageIds: string[] = [];

    for (let i = 0; i < conv.messages.length; i++) {
      const msg = conv.messages[i];
      const sender = users[msg.sender];

      // Build content → sign → encrypt
      const content = buildMessageContent(msg.text);
      const signature = signMessage(sender.identity.secretKey, content);

      const payload = new Uint8Array(SIGNATURE_SIZE + content.length);
      payload.set(signature, 0);
      payload.set(content, SIGNATURE_SIZE);

      const aad = buildContextAAD(PURPOSE_MESSAGE, conv.channelId, keyInfo.version);
      const encryptedContent = await encryptPayload(keyInfo.key, payload, aad);

      // Resolve reply-to
      const replyToId =
        msg.replyToIndex !== undefined ? sentMessageIds[msg.replyToIndex] : undefined;

      // Send via ChatService — match the client's sendMessage call exactly
      const chatClient = createChatClient(config, sender.accessToken);
      const res = await chatClient.sendMessage({
        channelId: conv.channelId,
        encryptedContent,
        keyVersion: keyInfo.version,
        nonce: crypto.randomUUID(),
        attachmentIds: [],
        replyToId,
        mentionedUserIds: [],
        mentionedRoleIds: [],
        mentionEveryone: false,
      });

      sentMessageIds.push(res.messageId);

      // Add reactions if specified
      if (msg.reactions) {
        for (const reaction of msg.reactions) {
          const reactor = users[reaction.user];
          const reactorChat = createChatClient(config, reactor.accessToken);
          await reactorChat.addReaction({
            channelId: conv.channelId,
            messageId: res.messageId,
            emoji: reaction.emoji,
          });
        }
      }
    }

    logIndent(`${conv.channelName} ... ${conv.messages.length} messages`);
  }
}
