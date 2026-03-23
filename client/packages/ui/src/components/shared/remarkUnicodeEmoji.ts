import emojiRegex from 'emoji-regex';
import type { Root, Text } from 'mdast';
import { visit } from 'unist-util-visit';

/** Custom MDAST node representing a native Unicode emoji. */
export interface MezaUnicodeEmojiNode {
  type: 'mezaUnicodeEmoji';
  data: {
    hName: 'meza-unicode-emoji';
  };
  children: [Text];
}

/**
 * Remark plugin that wraps native Unicode emoji sequences in custom
 * MDAST nodes so they can be sized independently from surrounding text.
 *
 * Skips text inside code blocks and inline code.
 */
export function remarkUnicodeEmoji() {
  return (tree: Root) => {
    const regex = emojiRegex();
    visit(tree, 'text', (node: Text, index, parent) => {
      if (!parent || index === undefined) return;
      // Skip code contexts
      const parentType = parent.type as string;
      if (parentType === 'code' || parentType === 'inlineCode') return;

      const value = node.value;
      let match: RegExpExecArray | null;
      let lastIndex = 0;
      const children: (Text | MezaUnicodeEmojiNode)[] = [];

      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
      while ((match = regex.exec(value)) !== null) {
        // Text before the emoji
        if (match.index > lastIndex) {
          children.push({
            type: 'text',
            value: value.slice(lastIndex, match.index),
          });
        }

        // Unicode emoji node
        children.push({
          type: 'mezaUnicodeEmoji' as 'text',
          data: {
            hName: 'meza-unicode-emoji',
          },
          children: [{ type: 'text', value: match[0] }],
        } as unknown as MezaUnicodeEmojiNode);

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
