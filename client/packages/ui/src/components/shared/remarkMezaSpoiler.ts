import type { Root, Text } from 'mdast';
import { visit } from 'unist-util-visit';

/**
 * Custom MDAST node representing spoiler text.
 *
 * Unlike MezaEmojiNode/MezaMentionNode which use hProperties to pass
 * attributes, this node uses hChildren to pass the spoiler content as text
 * children to the <meza-spoiler> HTML element.
 */
export interface MezaSpoilerNode {
  type: 'mezaSpoiler';
  data: {
    hName: 'meza-spoiler';
    hChildren: [{ type: 'text'; value: string }];
  };
}

const SPOILER_REGEX = /\|\|(.+?)\|\|/g;

/**
 * Remark plugin that transforms Discord-style spoiler syntax (||text||)
 * into custom MDAST nodes rendered as click-to-reveal elements.
 */
export function remarkMezaSpoiler() {
  return (tree: Root) => {
    visit(tree, 'text', (node: Text, index, parent) => {
      if (!parent || index === undefined) return;

      const value = node.value;
      const regex = new RegExp(SPOILER_REGEX.source, 'g');
      let match: RegExpExecArray | null;
      let lastIndex = 0;
      const children: (Text | MezaSpoilerNode)[] = [];

      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
      while ((match = regex.exec(value)) !== null) {
        // Text before the spoiler
        if (match.index > lastIndex) {
          children.push({
            type: 'text',
            value: value.slice(lastIndex, match.index),
          });
        }

        // Spoiler node
        children.push({
          type: 'mezaSpoiler' as 'text',
          data: {
            hName: 'meza-spoiler',
            hChildren: [{ type: 'text', value: match[1] }],
          },
        } as unknown as MezaSpoilerNode);

        lastIndex = regex.lastIndex;
      }

      if (children.length === 0) return;

      // Remaining text after last spoiler
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
