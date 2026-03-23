import { describe, expect, it } from 'vitest';
import { composerSchema } from './schema.ts';
import {
  deserializeText,
  serializeDoc,
  wireFormatLength,
} from './serialize.ts';

const schema = composerSchema;

/** Helper: round-trip text through deserialize then serialize. */
function roundTrip(text: string): string {
  return serializeDoc(deserializeText(text, schema));
}

describe('serializeDoc / deserializeText', () => {
  describe('round-trip', () => {
    it('plain text', () => {
      expect(roundTrip('hello world')).toBe('hello world');
    });

    it('user mention', () => {
      const text = '<@AAAAAAAAAAAAAAAAAAAAAAAAAA>';
      expect(roundTrip(text)).toBe(text);
    });

    it('role mention', () => {
      const text = '<@&AAAAAAAAAAAAAAAAAAAAAAAAAA>';
      expect(roundTrip(text)).toBe(text);
    });

    it('@everyone', () => {
      expect(roundTrip('@everyone')).toBe('@everyone');
    });

    it('custom emoji', () => {
      const text = '<:wave:abc123>';
      expect(roundTrip(text)).toBe(text);
    });

    it('animated custom emoji', () => {
      const text = '<a:dance:xyz789>';
      expect(roundTrip(text)).toBe(text);
    });

    it('channel link', () => {
      const text = '<#BBBBBBBBBBBBBBBBBBBBBBBBBB>';
      expect(roundTrip(text)).toBe(text);
    });
  });

  describe('adjacent entities', () => {
    it('two adjacent user mentions produce separate nodes', () => {
      const text = '<@AAAAAAAAAAAAAAAAAAAAAAAAAA><@BBBBBBBBBBBBBBBBBBBBBBBBBB>';
      const doc = deserializeText(text, schema);
      const para = doc.child(0);
      // Should have exactly 2 mention children, no text between them
      expect(para.childCount).toBe(2);
      expect(para.child(0).type.name).toBe('mention');
      expect(para.child(1).type.name).toBe('mention');
      expect(roundTrip(text)).toBe(text);
    });
  });

  describe('code span exemption', () => {
    it('mention inside backtick code span stays as text', () => {
      const text = '`<@AAAAAAAAAAAAAAAAAAAAAAAAAA>`';
      const doc = deserializeText(text, schema);
      const para = doc.child(0);
      // Should be a single text node containing the backtick-wrapped mention
      expect(para.childCount).toBe(1);
      expect(para.child(0).isText).toBe(true);
      expect(para.child(0).text).toBe('`<@AAAAAAAAAAAAAAAAAAAAAAAAAA>`');
    });

    it('code span with surrounding text', () => {
      const text = 'see `<@AAAAAAAAAAAAAAAAAAAAAAAAAA>` here';
      expect(roundTrip(text)).toBe(text);
    });
  });

  describe('malformed entities', () => {
    it('short ULID stays as plain text', () => {
      const text = '<@short>';
      expect(roundTrip(text)).toBe(text);
    });

    it('invalid role mention stays as plain text', () => {
      const text = '<@&TOOSHORT>';
      expect(roundTrip(text)).toBe(text);
    });

    it('mention with lowercase id stays as plain text', () => {
      const text = '<@aaaaaaaaaaaaaaaaaaaaaaaaaa>';
      expect(roundTrip(text)).toBe(text);
    });
  });

  describe('empty doc', () => {
    it('empty string produces a doc with one empty paragraph', () => {
      const doc = deserializeText('', schema);
      expect(doc.childCount).toBe(1);
      expect(doc.child(0).type.name).toBe('paragraph');
      expect(doc.child(0).childCount).toBe(0);
      expect(serializeDoc(doc)).toBe('');
    });
  });

  describe('multiple paragraphs', () => {
    it('newlines split into separate paragraphs', () => {
      const text = 'line one\nline two\nline three';
      const doc = deserializeText(text, schema);
      expect(doc.childCount).toBe(3);
      expect(roundTrip(text)).toBe(text);
    });
  });

  describe('mixed content', () => {
    it('text with mention and emoji', () => {
      const text = 'Hello <@AAAAAAAAAAAAAAAAAAAAAAAAAA> check <:wave:abc123>';
      expect(roundTrip(text)).toBe(text);

      const doc = deserializeText(text, schema);
      const para = doc.child(0);
      // "Hello " text, mention, " check " text, emoji
      expect(para.childCount).toBe(4);
      expect(para.child(0).isText).toBe(true);
      expect(para.child(0).text).toBe('Hello ');
      expect(para.child(1).type.name).toBe('mention');
      expect(para.child(2).isText).toBe(true);
      expect(para.child(2).text).toBe(' check ');
      expect(para.child(3).type.name).toBe('customEmoji');
    });
  });

  describe('@everyone handling', () => {
    it('standalone @everyone', () => {
      expect(roundTrip('@everyone')).toBe('@everyone');
    });

    it('@everyone in a sentence', () => {
      const text = 'Hey @everyone look at this';
      expect(roundTrip(text)).toBe(text);
    });

    it('@everyone produces a mention node with type everyone', () => {
      const doc = deserializeText('@everyone', schema);
      const para = doc.child(0);
      expect(para.child(0).type.name).toBe('mention');
      expect(para.child(0).attrs.type).toBe('everyone');
    });
  });

  describe('role mentions', () => {
    it('role mention round-trips', () => {
      const text = '<@&AAAAAAAAAAAAAAAAAAAAAAAAAA>';
      expect(roundTrip(text)).toBe(text);
    });

    it('role mention produces correct node attrs', () => {
      const doc = deserializeText('<@&AAAAAAAAAAAAAAAAAAAAAAAAAA>', schema);
      const para = doc.child(0);
      expect(para.child(0).type.name).toBe('mention');
      expect(para.child(0).attrs.type).toBe('role');
      expect(para.child(0).attrs.id).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAA');
    });
  });
});

describe('wireFormatLength', () => {
  it('matches serializeDoc length for plain text', () => {
    const text = 'hello world';
    const doc = deserializeText(text, schema);
    expect(wireFormatLength(doc)).toBe(serializeDoc(doc).length);
  });

  it('matches serializeDoc length for user mention', () => {
    const text = '<@AAAAAAAAAAAAAAAAAAAAAAAAAA>';
    const doc = deserializeText(text, schema);
    expect(wireFormatLength(doc)).toBe(serializeDoc(doc).length);
  });

  it('matches serializeDoc length for role mention', () => {
    const text = '<@&AAAAAAAAAAAAAAAAAAAAAAAAAA>';
    const doc = deserializeText(text, schema);
    expect(wireFormatLength(doc)).toBe(serializeDoc(doc).length);
  });

  it('matches serializeDoc length for @everyone', () => {
    const text = '@everyone';
    const doc = deserializeText(text, schema);
    expect(wireFormatLength(doc)).toBe(serializeDoc(doc).length);
  });

  it('matches serializeDoc length for custom emoji', () => {
    const text = '<:wave:abc123>';
    const doc = deserializeText(text, schema);
    expect(wireFormatLength(doc)).toBe(serializeDoc(doc).length);
  });

  it('matches serializeDoc length for animated emoji', () => {
    const text = '<a:dance:xyz789>';
    const doc = deserializeText(text, schema);
    expect(wireFormatLength(doc)).toBe(serializeDoc(doc).length);
  });

  it('matches serializeDoc length for channel link', () => {
    const text = '<#BBBBBBBBBBBBBBBBBBBBBBBBBB>';
    const doc = deserializeText(text, schema);
    expect(wireFormatLength(doc)).toBe(serializeDoc(doc).length);
  });

  it('matches serializeDoc length for multi-paragraph mixed content', () => {
    const text =
      'Hello <@AAAAAAAAAAAAAAAAAAAAAAAAAA> check <:wave:abc123>\n@everyone in <#BBBBBBBBBBBBBBBBBBBBBBBBBB>';
    const doc = deserializeText(text, schema);
    expect(wireFormatLength(doc)).toBe(serializeDoc(doc).length);
  });

  it('returns 0 for an empty doc', () => {
    const doc = deserializeText('', schema);
    expect(wireFormatLength(doc)).toBe(0);
  });
});
