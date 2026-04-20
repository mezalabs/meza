import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadFromStorage,
  useKeybindOverridesStore,
} from './keybindOverrides.ts';

const mockStorage = new Map<string, string>();

beforeEach(() => {
  mockStorage.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => mockStorage.get(key) ?? null,
    setItem: (key: string, value: string) => mockStorage.set(key, value),
    removeItem: (key: string) => mockStorage.delete(key),
  });
  useKeybindOverridesStore.setState({ overrides: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('keybind overrides store', () => {
  it('setOverride persists keys for a known id', () => {
    useKeybindOverridesStore.getState().setOverride('search', 'ctrl+p');
    expect(useKeybindOverridesStore.getState().getEffectiveKeys('search')).toBe(
      'ctrl+p',
    );
  });

  it('clearOverride removes keys but preserves isGlobal', () => {
    const store = useKeybindOverridesStore.getState();
    store.setOverride('search', 'ctrl+p');
    store.setGlobal('search', true);
    store.clearOverride('search');
    const after = useKeybindOverridesStore.getState();
    expect(after.getEffectiveKeys('search')).toBe('mod+k');
    expect(after.getEffectiveIsGlobal('search')).toBe(true);
  });

  it('setGlobal(false) prunes the entry when no other field is set', () => {
    const store = useKeybindOverridesStore.getState();
    store.setGlobal('search', true);
    store.setGlobal('search', false);
    expect(
      useKeybindOverridesStore.getState().overrides.search,
    ).toBeUndefined();
  });

  it('getGloballyEnabled returns only ids with isGlobal=true', () => {
    const store = useKeybindOverridesStore.getState();
    store.setGlobal('toggle-mute', true);
    store.setOverride('search', 'ctrl+p');
    expect(useKeybindOverridesStore.getState().getGloballyEnabled()).toEqual([
      'toggle-mute',
    ]);
  });
});

describe('loadFromStorage migration', () => {
  it('returns empty when storage is empty', () => {
    expect(loadFromStorage()).toEqual({});
  });

  it('returns empty when storage is malformed JSON', () => {
    mockStorage.set('meza:keybind_overrides', 'not json');
    expect(loadFromStorage()).toEqual({});
  });

  it('accepts the legacy bare-string shape and converts to {keys}', () => {
    mockStorage.set(
      'meza:keybind_overrides',
      JSON.stringify({ search: 'ctrl+shift+p' }),
    );
    expect(loadFromStorage()).toEqual({ search: { keys: 'ctrl+shift+p' } });
  });

  it('accepts the new {keys, isGlobal} shape', () => {
    mockStorage.set(
      'meza:keybind_overrides',
      JSON.stringify({ search: { keys: 'ctrl+p', isGlobal: true } }),
    );
    expect(loadFromStorage()).toEqual({
      search: { keys: 'ctrl+p', isGlobal: true },
    });
  });

  it('preserves only valid fields and drops everything else', () => {
    mockStorage.set(
      'meza:keybind_overrides',
      JSON.stringify({
        search: { keys: 'ctrl+p', isGlobal: true, junk: 'ignore' },
        'toggle-mute': { isGlobal: true },
        'toggle-deafen': { keys: 'alt+d' },
        'mark-channel-read': { keys: 42, isGlobal: 'yes' }, // wrong types
      }),
    );
    expect(loadFromStorage()).toEqual({
      search: { keys: 'ctrl+p', isGlobal: true },
      'toggle-mute': { isGlobal: true },
      'toggle-deafen': { keys: 'alt+d' },
      // mark-channel-read had no valid fields → dropped entirely
    });
  });

  it('rejects unknown ids', () => {
    mockStorage.set(
      'meza:keybind_overrides',
      JSON.stringify({
        search: { keys: 'ctrl+p' },
        'definitely-not-a-keybind': { keys: 'x' },
      }),
    );
    expect(loadFromStorage()).toEqual({ search: { keys: 'ctrl+p' } });
  });

  it('rejects non-object root', () => {
    mockStorage.set('meza:keybind_overrides', JSON.stringify(['array']));
    expect(loadFromStorage()).toEqual({});
    mockStorage.set('meza:keybind_overrides', JSON.stringify('string'));
    expect(loadFromStorage()).toEqual({});
    mockStorage.set('meza:keybind_overrides', JSON.stringify(null));
    expect(loadFromStorage()).toEqual({});
  });
});
