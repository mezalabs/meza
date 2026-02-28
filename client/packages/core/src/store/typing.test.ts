import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTypingStore } from './typing.ts';

beforeEach(() => {
  vi.useFakeTimers({ now: 1000 });
  useTypingStore.getState().reset();
});

afterEach(() => {
  useTypingStore.getState().reset();
  vi.useRealTimers();
});

describe('typing store', () => {
  it('starts with empty byChannel', () => {
    expect(useTypingStore.getState().byChannel).toEqual({});
  });

  it('setTyping adds user to channel with expiry', () => {
    useTypingStore.getState().setTyping('c1', 'u1');
    const state = useTypingStore.getState();
    expect(state.byChannel.c1).toBeDefined();
    expect(state.byChannel.c1?.u1).toBe(7000); // 1000 + 6000
  });

  it('setTyping creates channel entry if missing', () => {
    useTypingStore.getState().setTyping('new-channel', 'u1');
    expect(useTypingStore.getState().byChannel['new-channel']).toBeDefined();
  });

  it('clearExpired removes expired entries', () => {
    useTypingStore.getState().setTyping('c1', 'u1');
    useTypingStore.getState().setTyping('c1', 'u2');

    vi.setSystemTime(8000); // past u1's and u2's expiry (7000)
    useTypingStore.getState().clearExpired();

    expect(useTypingStore.getState().byChannel.c1).toBeUndefined();
  });

  it('clearExpired keeps non-expired entries', () => {
    useTypingStore.getState().setTyping('c1', 'u1'); // expires at 7000

    vi.setSystemTime(5000); // before expiry
    useTypingStore.getState().clearExpired();

    expect(useTypingStore.getState().byChannel.c1?.u1).toBe(7000);
  });

  it('clearChannel removes all users for a channel', () => {
    useTypingStore.getState().setTyping('c1', 'u1');
    useTypingStore.getState().setTyping('c1', 'u2');
    useTypingStore.getState().setTyping('c2', 'u3');

    useTypingStore.getState().clearChannel('c1');

    expect(useTypingStore.getState().byChannel.c1).toBeUndefined();
    expect(useTypingStore.getState().byChannel.c2).toBeDefined();
  });

  it('reset clears everything', () => {
    useTypingStore.getState().setTyping('c1', 'u1');
    useTypingStore.getState().setTyping('c2', 'u2');

    useTypingStore.getState().reset();

    expect(useTypingStore.getState().byChannel).toEqual({});
  });
});

describe('typing store cleanup interval', () => {
  it('setTyping starts the cleanup interval', () => {
    useTypingStore.getState().setTyping('c1', 'u1');

    // Advance past expiry + one interval tick
    vi.setSystemTime(8000);
    vi.advanceTimersByTime(3000);

    // clearExpired should have been called automatically, removing expired entry
    expect(useTypingStore.getState().byChannel.c1).toBeUndefined();
  });

  it('interval auto-stops when all entries expire', () => {
    useTypingStore.getState().setTyping('c1', 'u1'); // expires at 7000

    // Advance past expiry and trigger interval tick to clear + stop
    vi.setSystemTime(8000);
    vi.advanceTimersByTime(3000);
    expect(useTypingStore.getState().byChannel).toEqual({});

    // Now add a new entry — it should start the interval fresh
    vi.setSystemTime(10000);
    useTypingStore.getState().setTyping('c2', 'u2'); // expires at 16000

    vi.setSystemTime(17000);
    vi.advanceTimersByTime(3000);
    expect(useTypingStore.getState().byChannel.c2).toBeUndefined();
  });

  it('reset stops the cleanup interval', () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    useTypingStore.getState().setTyping('c1', 'u1');
    useTypingStore.getState().reset();

    // clearInterval should have been called by reset
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });

  it('multiple setTyping calls do not create multiple intervals', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const callsBefore = setIntervalSpy.mock.calls.length;

    useTypingStore.getState().setTyping('c1', 'u1');
    useTypingStore.getState().setTyping('c1', 'u2');
    useTypingStore.getState().setTyping('c2', 'u3');

    // Only one setInterval call should have been made (the first setTyping)
    expect(setIntervalSpy.mock.calls.length - callsBefore).toBe(1);
    setIntervalSpy.mockRestore();
  });
});
