import { defaultSchema } from 'rehype-sanitize';

/**
 * Custom sanitization schema for Meza markdown rendering.
 * Extends the default schema with GFM elements while stripping
 * dangerous attributes and protocols.
 */
export const MEZA_SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    // GFM tables
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    // Strikethrough
    'del',
    // Task list checkboxes
    'input',
    // Custom Meza emoji elements (from remarkMezaEmoji plugin)
    'meza-emoji',
    // Custom Meza mention elements (from remarkMezaMention plugin)
    'meza-mention',
    // Spoiler text (from remarkMezaSpoiler plugin)
    'meza-spoiler',
    // Native Unicode emoji wrapper (from remarkUnicodeEmoji plugin)
    'meza-unicode-emoji',
  ],
  attributes: {
    ...defaultSchema.attributes,
    input: [['type', 'checkbox'], ['disabled', true], ['checked']],
    th: ['align'],
    td: ['align'],
    code: ['className'],
    span: ['className'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'className'],
    a: ['href', 'title', 'target', 'rel'],
    'meza-emoji': ['emojiId', 'emojiName', 'animated'],
    'meza-mention': ['mentionType', 'mentionId'],
  },
  protocols: {
    href: ['http', 'https', 'mailto'],
    src: ['http', 'https'],
  },
  strip: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
};
