import type { Root, Text } from 'mdast';
import { visit } from 'unist-util-visit';

/** Custom MDAST node representing a Meza custom emoji. */
export interface MezaEmojiNode {
  type: 'mezaEmoji';
  data: {
    hName: 'meza-emoji';
    hProperties: {
      emojiId: string;
      emojiName: string;
      animated: boolean;
    };
  };
}

const EMOJI_REGEX = /<(a?):([a-z0-9_]{2,32}):([a-zA-Z0-9]+)>/g;

/**
 * Remark plugin that transforms Meza custom emoji patterns
 * (<a:name:id> / <:name:id>) into custom MDAST nodes.
 *
 * This prevents the markdown parser from interpreting them as HTML tags
 * and ensures rehype-sanitize doesn't strip them.
 */
export function remarkMezaEmoji() {
  return (tree: Root) => {
    visit(tree, 'text', (node: Text, index, parent) => {
      if (!parent || index === undefined) return;

      const value = node.value;
      const regex = new RegExp(EMOJI_REGEX.source, 'g');
      let match: RegExpExecArray | null;
      let lastIndex = 0;
      const children: (Text | MezaEmojiNode)[] = [];

      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
      while ((match = regex.exec(value)) !== null) {
        // Text before the emoji
        if (match.index > lastIndex) {
          children.push({
            type: 'text',
            value: value.slice(lastIndex, match.index),
          });
        }

        // Emoji node
        children.push({
          type: 'mezaEmoji' as 'text',
          data: {
            hName: 'meza-emoji',
            hProperties: {
              emojiId: match[3],
              emojiName: match[2],
              animated: match[1] === 'a',
            },
          },
        } as unknown as MezaEmojiNode);

        lastIndex = regex.lastIndex;
      }

      if (children.length === 0) return;

      // Remaining text after last emoji
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
