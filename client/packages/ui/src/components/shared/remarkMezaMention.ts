import type { Root, Text } from 'mdast';
import { visit } from 'unist-util-visit';

/** Custom MDAST node representing a Meza mention. */
export interface MezaMentionNode {
  type: 'mezaMention';
  data: {
    hName: 'meza-mention';
    hProperties: {
      mentionType: 'user' | 'role' | 'everyone';
      mentionId: string;
    };
  };
}

// Matches <@01HWXYZ26CHARULID> for user mentions.
const USER_MENTION_REGEX = /<@([A-Z0-9]{26})>/g;
// Matches <@&01HWXYZ26CHARULID> for role mentions.
const ROLE_MENTION_REGEX = /<@&([A-Z0-9]{26})>/g;
// Matches @everyone (whole word).
const EVERYONE_REGEX = /@everyone\b/g;

/**
 * Remark plugin that transforms <@userId> and @everyone patterns
 * in text nodes into custom MDAST nodes before rehype processes them.
 *
 * Follows the same pattern as remarkMezaEmoji.
 */
export function remarkMezaMention() {
  return (tree: Root) => {
    visit(tree, 'text', (node: Text, index, parent) => {
      if (!parent || index === undefined) return;

      const value = node.value;

      // Combined regex: match user mentions, role mentions, and @everyone.
      const combinedRegex = new RegExp(
        `${USER_MENTION_REGEX.source}|${ROLE_MENTION_REGEX.source}|${EVERYONE_REGEX.source}`,
        'g',
      );
      let match: RegExpExecArray | null;
      let lastIndex = 0;
      const children: (Text | MezaMentionNode)[] = [];

      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
      while ((match = combinedRegex.exec(value)) !== null) {
        // Text before the mention
        if (match.index > lastIndex) {
          children.push({
            type: 'text',
            value: value.slice(lastIndex, match.index),
          });
        }

        if (match[1]) {
          // User mention: <@ULID>
          children.push({
            type: 'mezaMention' as 'text',
            data: {
              hName: 'meza-mention',
              hProperties: {
                mentionType: 'user',
                mentionId: match[1],
              },
            },
          } as unknown as MezaMentionNode);
        } else if (match[2]) {
          // Role mention: <@&ULID>
          children.push({
            type: 'mezaMention' as 'text',
            data: {
              hName: 'meza-mention',
              hProperties: {
                mentionType: 'role',
                mentionId: match[2],
              },
            },
          } as unknown as MezaMentionNode);
        } else {
          // @everyone
          children.push({
            type: 'mezaMention' as 'text',
            data: {
              hName: 'meza-mention',
              hProperties: {
                mentionType: 'everyone',
                mentionId: '',
              },
            },
          } as unknown as MezaMentionNode);
        }

        lastIndex = combinedRegex.lastIndex;
      }

      if (children.length === 0) return;

      // Remaining text after last mention
      if (lastIndex < value.length) {
        children.push({
          type: 'text',
          value: value.slice(lastIndex),
        });
      }

      // Replace the text node with our new children
      parent.children.splice(
        index,
        1,
        ...(children as unknown as typeof parent.children),
      );
    });
  };
}
