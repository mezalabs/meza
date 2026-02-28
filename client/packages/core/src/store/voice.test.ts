import { beforeEach, describe, expect, it } from 'vitest';
import { useVoiceStore } from './voice.ts';

beforeEach(() => {
  useVoiceStore.setState({
    status: 'idle',
    livekitUrl: null,
    livekitToken: null,
    channelId: null,
    channelName: null,
    canScreenShare: false,
    error: null,
  });
});

describe('voice store', () => {
  it('starts idle', () => {
    const state = useVoiceStore.getState();
    expect(state.status).toBe('idle');
    expect(state.channelId).toBeNull();
  });

  it('setConnecting updates status and channel info', () => {
    useVoiceStore.getState().setConnecting('ch1', 'Voice Chat');
    const state = useVoiceStore.getState();

    expect(state.status).toBe('connecting');
    expect(state.channelId).toBe('ch1');
    expect(state.channelName).toBe('Voice Chat');
    expect(state.error).toBeNull();
  });

  it('setConnected stores livekit credentials', () => {
    useVoiceStore.getState().setConnecting('ch1', 'Voice Chat');
    useVoiceStore
      .getState()
      .setConnected('wss://lk.example.com', 'token123', true);

    const state = useVoiceStore.getState();
    expect(state.status).toBe('connected');
    expect(state.livekitUrl).toBe('wss://lk.example.com');
    expect(state.livekitToken).toBe('token123');
    expect(state.canScreenShare).toBe(true);
  });

  it('setReconnecting updates status', () => {
    useVoiceStore.getState().setConnecting('ch1', 'Voice Chat');
    useVoiceStore.getState().setConnected('url', 'token', false);
    useVoiceStore.getState().setReconnecting();

    expect(useVoiceStore.getState().status).toBe('reconnecting');
  });

  it('disconnect resets to initial state', () => {
    useVoiceStore.getState().setConnecting('ch1', 'Voice Chat');
    useVoiceStore.getState().setConnected('url', 'token', true);
    useVoiceStore.getState().disconnect();

    const state = useVoiceStore.getState();
    expect(state.status).toBe('idle');
    expect(state.channelId).toBeNull();
    expect(state.livekitUrl).toBeNull();
  });

  it('setError resets to idle with error', () => {
    useVoiceStore.getState().setConnecting('ch1', 'Voice Chat');
    useVoiceStore.getState().setError('connection failed');

    const state = useVoiceStore.getState();
    expect(state.status).toBe('idle');
    expect(state.error).toBe('connection failed');
    expect(state.channelId).toBeNull();
  });

  it('setError with null clears error', () => {
    useVoiceStore.getState().setError('old error');
    useVoiceStore.getState().setError(null);

    expect(useVoiceStore.getState().error).toBeNull();
  });
});
