import { type NodeSpec, Schema } from 'prosemirror-model';

/* ------------------------------------------------------------------ */
/*  Branded wire-format type                                          */
/* ------------------------------------------------------------------ */

declare const __wireFormat: unique symbol;

/**
 * A string serialised into the wire text format (e.g. `<@ULID>`, `<:name:id>`).
 * The brand prevents accidental assignment of arbitrary strings.
 */
export type WireFormatText = string & { readonly [__wireFormat]: true };

/* ------------------------------------------------------------------ */
/*  Attr interfaces                                                   */
/* ------------------------------------------------------------------ */

export interface MentionAttrs {
  id: string;
  type: 'user' | 'role' | 'everyone';
}

export interface CustomEmojiAttrs {
  id: string;
  name: string;
  animated: boolean;
}

export interface ChannelLinkAttrs {
  id: string;
}

/* ------------------------------------------------------------------ */
/*  Autocomplete discriminated union                                  */
/* ------------------------------------------------------------------ */

export type AutocompleteSelection =
  | { trigger: 'mention'; attrs: MentionAttrs }
  | { trigger: 'channel'; attrs: ChannelLinkAttrs }
  | { trigger: 'emoji'; attrs: CustomEmojiAttrs }
  | { trigger: 'slash'; command: string; args: string };

/* ------------------------------------------------------------------ */
/*  Node specs                                                        */
/* ------------------------------------------------------------------ */

// SECURITY: No parseDOM on atom nodes. They are only created programmatically
// via autocomplete or deserialization — never from pasted HTML.

const INLINE_ATOM_STYLE = 'display: inline-block; user-select: all;';

const mention: NodeSpec = {
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  attrs: {
    id: {},
    type: { default: 'user' },
  },
  leafText(node) {
    const { id, type } = node.attrs as MentionAttrs;
    if (type === 'everyone') return '@everyone';
    if (type === 'role') return `<@&${id}>`;
    return `<@${id}>`;
  },
  toDOM(node) {
    return [
      'span',
      {
        class: 'mention-node',
        'data-mention-id': node.attrs.id,
        'data-mention-type': node.attrs.type,
        contenteditable: 'false',
        style: INLINE_ATOM_STYLE,
      },
    ];
  },
};

const customEmoji: NodeSpec = {
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  attrs: {
    id: {},
    name: {},
    animated: { default: false },
  },
  leafText(node) {
    const { id, name, animated } = node.attrs as CustomEmojiAttrs;
    return animated ? `<a:${name}:${id}>` : `<:${name}:${id}>`;
  },
  toDOM(node) {
    return [
      'span',
      {
        class: 'emoji-node',
        'data-emoji-id': node.attrs.id,
        'data-emoji-name': node.attrs.name,
        'data-emoji-animated': String(node.attrs.animated),
        contenteditable: 'false',
        style: INLINE_ATOM_STYLE,
      },
    ];
  },
};

const channelLink: NodeSpec = {
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  attrs: {
    id: {},
  },
  leafText(node) {
    return `<#${(node.attrs as ChannelLinkAttrs).id}>`;
  },
  toDOM(node) {
    return [
      'span',
      {
        class: 'channel-link-node',
        'data-channel-id': node.attrs.id,
        contenteditable: 'false',
        style: INLINE_ATOM_STYLE,
      },
    ];
  },
};

/* ------------------------------------------------------------------ */
/*  Schema                                                            */
/* ------------------------------------------------------------------ */

export const composerSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'inline*',
      toDOM: () => ['p', 0] as const,
    },
    text: { group: 'inline' },
    mention,
    customEmoji,
    channelLink,
  },
  marks: {},
});

/* ------------------------------------------------------------------ */
/*  Derived types                                                     */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Editor handle (imperative ref exposed via React.forwardRef)       */
/* ------------------------------------------------------------------ */

export interface ComposerEditorHandle {
  isDirty(): boolean;
  insertText(text: string): void;
  focus(): void;
  clear(): void;
  /** Serialize the doc and invoke the onSend callback (for mobile send button). */
  send(): void;
}
