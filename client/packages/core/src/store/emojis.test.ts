import { beforeEach, describe, expect, it } from 'vitest';
import { useEmojiStore } from './emojis.ts';

// biome-ignore lint/suspicious/noExplicitAny: test fixture — plain objects standing in for protobuf messages
const emoji1: any = {
  id: 'e1',
  serverId: 's1',
  name: 'fire',
  imageUrl: '/media/1',
};
// biome-ignore lint/suspicious/noExplicitAny: test fixture
const emoji2: any = {
  id: 'e2',
  serverId: 's1',
  name: 'ice',
  imageUrl: '/media/2',
};
// biome-ignore lint/suspicious/noExplicitAny: test fixture
const emoji3: any = {
  id: 'e3',
  serverId: 's1',
  name: 'apple',
  imageUrl: '/media/3',
};

beforeEach(() => {
  useEmojiStore.setState({ byServer: {}, isLoading: false, error: null });
});

describe('emoji store', () => {
  it('starts empty', () => {
    expect(useEmojiStore.getState().byServer).toEqual({});
  });

  it('setEmojis stores and sorts alphabetically', () => {
    useEmojiStore.getState().setEmojis('s1', [emoji1, emoji2, emoji3]);
    const emojis = useEmojiStore.getState().byServer.s1;

    expect(emojis).toHaveLength(3);
    expect(emojis?.[0].name).toBe('apple');
    expect(emojis?.[1].name).toBe('fire');
    expect(emojis?.[2].name).toBe('ice');
  });

  it('addEmoji inserts and maintains sort', () => {
    useEmojiStore.getState().setEmojis('s1', [emoji1]);
    useEmojiStore.getState().addEmoji(emoji3);

    const emojis = useEmojiStore.getState().byServer.s1;
    expect(emojis).toHaveLength(2);
    expect(emojis?.[0].name).toBe('apple');
    expect(emojis?.[1].name).toBe('fire');
  });

  it('addEmoji creates server entry if missing', () => {
    useEmojiStore.getState().addEmoji(emoji1);
    expect(useEmojiStore.getState().byServer.s1).toHaveLength(1);
  });

  it('updateEmoji replaces emoji data and re-sorts', () => {
    useEmojiStore.getState().setEmojis('s1', [emoji1, emoji2]);
    const updated = { ...emoji1, name: 'zap' };
    useEmojiStore.getState().updateEmoji(updated);

    const emojis = useEmojiStore.getState().byServer.s1;
    expect(emojis?.[0].name).toBe('ice');
    expect(emojis?.[1].name).toBe('zap');
  });

  it('updateEmoji does nothing for unknown emoji', () => {
    useEmojiStore.getState().setEmojis('s1', [emoji1]);
    useEmojiStore
      .getState()
      .updateEmoji({ id: 'unknown', serverId: 's1', name: 'x' } as never);
    expect(useEmojiStore.getState().byServer.s1).toHaveLength(1);
  });

  it('removeEmoji removes by id', () => {
    useEmojiStore.getState().setEmojis('s1', [emoji1, emoji2]);
    useEmojiStore.getState().removeEmoji('s1', 'e1');

    expect(useEmojiStore.getState().byServer.s1).toHaveLength(1);
    expect(useEmojiStore.getState().byServer.s1?.[0].id).toBe('e2');
  });

  it('removeEmoji does nothing for unknown server', () => {
    useEmojiStore.getState().removeEmoji('unknown', 'e1');
    expect(useEmojiStore.getState().byServer).toEqual({});
  });

  it('reset clears everything', () => {
    useEmojiStore.getState().setEmojis('s1', [emoji1]);
    useEmojiStore.getState().reset();

    const state = useEmojiStore.getState();
    expect(state.byServer).toEqual({});
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
  });
});
