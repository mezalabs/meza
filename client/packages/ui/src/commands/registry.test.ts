import { describe, expect, it, vi } from 'vitest';
import type { SlashCommand } from './registry.ts';
import {
  getAllCommands,
  getCommand,
  registerCommand,
  searchCommands,
} from './registry.ts';

// The registry is module-level state, so we need to re-register for each test.
// Since there's no `clear()`, we import fresh commands per describe block.

function makeCommand(overrides: Partial<SlashCommand> = {}): SlashCommand {
  return {
    name: 'test',
    description: 'A test command',
    execute: vi.fn(),
    ...overrides,
  };
}

describe('registerCommand / getCommand', () => {
  it('registers and retrieves a command by name', () => {
    const cmd = makeCommand({ name: 'ping' });
    registerCommand(cmd);

    expect(getCommand('ping')).toBe(cmd);
  });

  it('returns undefined for unknown commands', () => {
    expect(getCommand('nonexistent')).toBeUndefined();
  });

  it('overwrites a command with the same name', () => {
    const first = makeCommand({ name: 'dup', description: 'first' });
    const second = makeCommand({ name: 'dup', description: 'second' });
    registerCommand(first);
    registerCommand(second);

    expect(getCommand('dup')).toBe(second);
  });
});

describe('searchCommands', () => {
  it('matches by command name', () => {
    registerCommand(makeCommand({ name: 'shrug', description: 'Shrug emoji' }));
    registerCommand(
      makeCommand({ name: 'shrugmore', description: 'Even more shrug' }),
    );
    registerCommand(makeCommand({ name: 'gif', description: 'Search GIFs' }));

    const results = searchCommands('shrug');
    const names = results.map((c) => c.name);

    expect(names).toContain('shrug');
    expect(names).toContain('shrugmore');
    expect(names).not.toContain('gif');
  });

  it('matches by description (case-insensitive)', () => {
    registerCommand(
      makeCommand({ name: 'vertical', description: 'Split into columns' }),
    );

    const results = searchCommands('columns');
    expect(results.map((c) => c.name)).toContain('vertical');
  });

  it('returns all commands for empty query', () => {
    const all = getAllCommands();
    const results = searchCommands('');

    expect(results.length).toBe(all.length);
  });
});

describe('getAllCommands', () => {
  it('returns all registered commands', () => {
    registerCommand(makeCommand({ name: 'a' }));
    registerCommand(makeCommand({ name: 'b' }));

    const all = getAllCommands();
    const names = all.map((c) => c.name);

    expect(names).toContain('a');
    expect(names).toContain('b');
  });
});
