import type { Node as ProseMirrorNode, Schema } from 'prosemirror-model';
import type {
  ChannelLinkAttrs,
  CustomEmojiAttrs,
  MentionAttrs,
} from './schema.ts';

/* ------------------------------------------------------------------ */
/*  Validation regexes                                                */
/* ------------------------------------------------------------------ */

export const ULID_RE = /^[0-9A-Z]{26}$/;
export const EMOJI_NAME_RE = /^[a-z0-9_]{2,32}$/;
export const EMOJI_ID_RE = /^[a-zA-Z0-9]+$/;

/* ------------------------------------------------------------------ */
/*  Tokenizer regex (matches wire-format entities)                    */
/* ------------------------------------------------------------------ */

/**
 * Matches (in order):
 *  1. backtick code spans (group 1)
 *  2. role mention  `<@&ULID>` (group 2)
 *  3. user mention  `<@ULID>`  (group 3)
 *  4. @everyone
 *  5. custom emoji  `<a?:name:id>` (groups 5, 6, 7)
 *  6. channel link  `<#ULID>` (group 8)
 */
const TOKEN_RE =
  /(`[^`]*`)|<@&([A-Z0-9]{26})>|<@([A-Z0-9]{26})>|(@everyone)|<(a?):([a-z0-9_]{2,32}):([a-zA-Z0-9]+)>|<#([A-Z0-9]{26})>/g;

/* ------------------------------------------------------------------ */
/*  serializeDoc                                                      */
/* ------------------------------------------------------------------ */

export function serializeDoc(doc: ProseMirrorNode): string {
  const paragraphs: string[] = [];

  for (let i = 0; i < doc.childCount; i++) {
    const para = doc.child(i);
    let text = '';

    para.descendants((node) => {
      if (node.isText) {
        text += node.text;
        return false;
      }

      switch (node.type.name) {
        case 'mention': {
          const { id, type } = node.attrs as MentionAttrs;
          if (type === 'everyone') text += '@everyone';
          else if (type === 'role') text += `<@&${id}>`;
          else text += `<@${id}>`;
          return false;
        }
        case 'customEmoji': {
          const { id, name, animated } = node.attrs as CustomEmojiAttrs;
          text += animated ? `<a:${name}:${id}>` : `<:${name}:${id}>`;
          return false;
        }
        case 'channelLink': {
          const { id } = node.attrs as ChannelLinkAttrs;
          text += `<#${id}>`;
          return false;
        }
        default:
          return true;
      }
    });

    paragraphs.push(text);
  }

  return paragraphs.join('\n');
}

/* ------------------------------------------------------------------ */
/*  deserializeText                                                   */
/* ------------------------------------------------------------------ */

export function deserializeText(text: string, schema: Schema): ProseMirrorNode {
  const lines = text.split('\n');
  const paragraphs: ProseMirrorNode[] = [];

  for (const line of lines) {
    const children: ProseMirrorNode[] = [];
    let lastIndex = 0;

    TOKEN_RE.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = TOKEN_RE.exec(line)) !== null) {
      const [
        fullMatch,
        codeSpan, // group 1: backtick code span
        roleId, // group 2: role mention
        userId, // group 3: user mention
        everyone, // group 4: @everyone
        emojiAnim, // group 5: emoji animated prefix
        emojiName, // group 6: emoji name
        emojiId, // group 7: emoji id
        channelId, // group 8: channel link
      ] = match;

      // Code span: emit as plain text (skip entity parsing)
      if (codeSpan) {
        if (match.index > lastIndex) {
          children.push(schema.text(line.slice(lastIndex, match.index)));
        }
        children.push(schema.text(codeSpan));
        lastIndex = match.index + fullMatch.length;
        continue;
      }

      // Emit any text before this entity
      if (match.index > lastIndex) {
        children.push(schema.text(line.slice(lastIndex, match.index)));
      }

      if (roleId && ULID_RE.test(roleId)) {
        children.push(
          schema.nodes.mention.create({ id: roleId, type: 'role' }),
        );
      } else if (userId && ULID_RE.test(userId)) {
        children.push(
          schema.nodes.mention.create({ id: userId, type: 'user' }),
        );
      } else if (everyone) {
        children.push(
          schema.nodes.mention.create({ id: '', type: 'everyone' }),
        );
      } else if (
        emojiName !== undefined &&
        emojiId !== undefined &&
        EMOJI_NAME_RE.test(emojiName) &&
        EMOJI_ID_RE.test(emojiId)
      ) {
        children.push(
          schema.nodes.customEmoji.create({
            id: emojiId,
            name: emojiName,
            animated: emojiAnim === 'a',
          }),
        );
      } else if (channelId && ULID_RE.test(channelId)) {
        children.push(schema.nodes.channelLink.create({ id: channelId }));
      } else {
        // Malformed entity: emit as plain text
        children.push(schema.text(fullMatch));
      }

      lastIndex = match.index + fullMatch.length;
    }

    // Remaining text after last match
    if (lastIndex < line.length) {
      children.push(schema.text(line.slice(lastIndex)));
    }

    paragraphs.push(
      schema.nodes.paragraph.create(
        null,
        children.length > 0 ? children : undefined,
      ),
    );
  }

  return schema.nodes.doc.create(null, paragraphs);
}

/* ------------------------------------------------------------------ */
/*  wireFormatLength                                                  */
/* ------------------------------------------------------------------ */

export function wireFormatLength(doc: ProseMirrorNode): number {
  let length = 0;

  doc.descendants((node) => {
    if (node.isText) {
      length += node.text!.length;
      return false;
    }

    switch (node.type.name) {
      case 'mention': {
        const { type } = node.attrs as MentionAttrs;
        if (type === 'everyone')
          length += 9; // @everyone
        else if (type === 'role')
          length += 30; // <@& (3) + 26 + > (1)
        else length += 29; // <@ (2) + 26 + > (1)
        return false;
      }
      case 'customEmoji': {
        const { id, name, animated } = node.attrs as CustomEmojiAttrs;
        // <:name:id> = 4 + name + id, <a:name:id> = 5 + name + id
        length += name.length + id.length + (animated ? 5 : 4);
        return false;
      }
      case 'channelLink': {
        const { id } = node.attrs as ChannelLinkAttrs;
        // <#id> = 3 + id
        length += id.length + 3;
        return false;
      }
      default:
        return true;
    }
  });

  // Newlines between paragraphs
  length += Math.max(0, doc.childCount - 1);

  return length;
}
