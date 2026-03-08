import { beforeEach, describe, expect, it } from 'vitest';
import { useMessageStore } from './messages.ts';

const msg1 = { id: 'm1', channelId: 'c1', authorId: 'u1' } as never;
const msg2 = { id: 'm2', channelId: 'c1', authorId: 'u2' } as never;
const msg3 = { id: 'm3', channelId: 'c1', authorId: 'u1' } as never;

beforeEach(() => {
  useMessageStore.setState({
    byInstance: {},
    byChannel: {},
    byId: {},
    hasMore: {},
    isLoading: {},
    error: {},
    viewMode: {},
    pendingMessages: {},
    replyingTo: {},
  });
});

describe('message store', () => {
  it('starts with empty messages', () => {
    expect(useMessageStore.getState().byChannel).toEqual({});
  });

  it('setMessages replaces messages for channel', () => {
    useMessageStore.getState().setMessages('c1', [msg1, msg2]);
    expect(useMessageStore.getState().byChannel.c1).toHaveLength(2);

    useMessageStore.getState().setMessages('c1', [msg1]);
    expect(useMessageStore.getState().byChannel.c1).toHaveLength(1);
  });

  it('prependMessages prepends for pagination', () => {
    useMessageStore.getState().setMessages('c1', [msg2, msg3]);
    useMessageStore.getState().prependMessages('c1', [msg1]);

    const messages = useMessageStore.getState().byChannel.c1;
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual(msg1);
    expect(messages[1]).toEqual(msg2);
  });

  it('addMessage appends to channel', () => {
    useMessageStore.getState().setMessages('c1', [msg1]);
    useMessageStore.getState().addMessage('c1', msg2);

    const messages = useMessageStore.getState().byChannel.c1;
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual(msg2);
  });

  it('addMessage creates channel list if missing', () => {
    useMessageStore.getState().addMessage('c2', msg1);
    expect(useMessageStore.getState().byChannel.c2).toHaveLength(1);
  });

  it('setHasMore tracks pagination', () => {
    useMessageStore.getState().setHasMore('c1', true);
    expect(useMessageStore.getState().hasMore.c1).toBe(true);

    useMessageStore.getState().setHasMore('c1', false);
    expect(useMessageStore.getState().hasMore.c1).toBe(false);
  });

  it('setLoading tracks per-channel loading', () => {
    useMessageStore.getState().setLoading('c1', true);
    expect(useMessageStore.getState().isLoading.c1).toBe(true);
    expect(useMessageStore.getState().isLoading.c2).toBeUndefined();

    useMessageStore.getState().setLoading('c1', false);
    expect(useMessageStore.getState().isLoading.c1).toBeUndefined();
  });

  it('setMessages clears loading for channel', () => {
    useMessageStore.getState().setLoading('c1', true);
    useMessageStore.getState().setMessages('c1', [msg1]);
    expect(useMessageStore.getState().isLoading.c1).toBeUndefined();
  });

  it('setError sets per-channel error and clears loading', () => {
    useMessageStore.getState().setLoading('c1', true);
    useMessageStore.getState().setError('c1', 'Failed');

    const state = useMessageStore.getState();
    expect(state.error.c1).toBe('Failed');
    expect(state.isLoading.c1).toBeUndefined();
  });

  it('setError with null clears error for channel', () => {
    useMessageStore.getState().setError('c1', 'old error');
    useMessageStore.getState().setError('c1', null);
    expect(useMessageStore.getState().error.c1).toBeUndefined();
  });
});
