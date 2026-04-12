import { describe, expect, it } from 'vitest';
import { charToTwemojiFilename } from './twemoji.ts';

describe('charToTwemojiFilename', () => {
  it('converts a basic emoji', () => {
    // 😀 U+1F600
    expect(charToTwemojiFilename('😀')).toBe('1f600.svg');
  });

  it('converts a single-codepoint emoji', () => {
    // ❤ U+2764 (without FE0F)
    expect(charToTwemojiFilename('❤')).toBe('2764.svg');
  });

  it('strips FE0F when no ZWJ is present', () => {
    // ❤️ U+2764 U+FE0F
    expect(charToTwemojiFilename('❤️')).toBe('2764.svg');
  });

  it('handles skin tone modifier', () => {
    // 👋🏿 U+1F44B U+1F3FF
    expect(charToTwemojiFilename('👋🏿')).toBe('1f44b-1f3ff.svg');
  });

  it('handles skin tone modifier (light)', () => {
    // 👋🏻 U+1F44B U+1F3FB
    expect(charToTwemojiFilename('👋🏻')).toBe('1f44b-1f3fb.svg');
  });

  it('preserves FE0F when ZWJ is present', () => {
    // ❤️‍🔥 heart on fire: U+2764 U+FE0F U+200D U+1F525
    expect(charToTwemojiFilename('❤️‍🔥')).toBe(
      '2764-fe0f-200d-1f525.svg',
    );
  });

  it('handles ZWJ sequence with FE0F (couple with heart)', () => {
    // 👨‍❤️‍👨 U+1F468 U+200D U+2764 U+FE0F U+200D U+1F468
    expect(charToTwemojiFilename('👨‍❤️‍👨')).toBe(
      '1f468-200d-2764-fe0f-200d-1f468.svg',
    );
  });

  it('handles ZWJ sequence without FE0F', () => {
    // 👨‍🌾 farmer: U+1F468 U+200D U+1F33E
    expect(charToTwemojiFilename('👨‍🌾')).toBe('1f468-200d-1f33e.svg');
  });

  it('handles flag sequence', () => {
    // 🇺🇸 U+1F1FA U+1F1F8
    expect(charToTwemojiFilename('🇺🇸')).toBe('1f1fa-1f1f8.svg');
  });

  it('handles another flag sequence', () => {
    // 🇯🇵 U+1F1EF U+1F1F5
    expect(charToTwemojiFilename('🇯🇵')).toBe('1f1ef-1f1f5.svg');
  });

  it('strips FE0F from keycap sequence', () => {
    // 1️⃣ U+0031 U+FE0F U+20E3
    expect(charToTwemojiFilename('1️⃣')).toBe('31-20e3.svg');
  });

  it('strips FE0F from hash keycap', () => {
    // #️⃣ U+0023 U+FE0F U+20E3
    expect(charToTwemojiFilename('#️⃣')).toBe('23-20e3.svg');
  });

  it('handles thumbs up (common emoji)', () => {
    // 👍 U+1F44D
    expect(charToTwemojiFilename('👍')).toBe('1f44d.svg');
  });

  it('handles fire emoji', () => {
    // 🔥 U+1F525
    expect(charToTwemojiFilename('🔥')).toBe('1f525.svg');
  });

  it('handles folded hands (pray)', () => {
    // 🙏 U+1F64F
    expect(charToTwemojiFilename('🙏')).toBe('1f64f.svg');
  });

  it('handles face with tears of joy', () => {
    // 😂 U+1F602
    expect(charToTwemojiFilename('😂')).toBe('1f602.svg');
  });

  it('handles ZWJ profession sequence with skin tone and FE0F', () => {
    // 👨🏻‍💻 man technologist light skin: U+1F468 U+1F3FB U+200D U+1F4BB
    expect(charToTwemojiFilename('👨🏻‍💻')).toBe(
      '1f468-1f3fb-200d-1f4bb.svg',
    );
  });
});
