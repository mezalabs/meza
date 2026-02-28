import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePresenceStore } from '../store/presence.ts';

// ---------------------------------------------------------------------------
// Mock the ConnectRPC presence client
// ---------------------------------------------------------------------------
const mockPresenceClient: Record<string, ReturnType<typeof vi.fn>> = {
  updatePresence: vi.fn(),
  getPresence: vi.fn(),
  getBulkPresence: vi.fn(),
};

vi.mock('@connectrpc/connect', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createClient: vi.fn(() => mockPresenceClient),
  };
});

vi.mock('./client.ts', () => ({
  transport: {},
}));

beforeEach(() => {
  vi.clearAllMocks();
  usePresenceStore.setState({ byUser: {} });
});

// ---------------------------------------------------------------------------
// updatePresence
// ---------------------------------------------------------------------------
describe('updatePresence', () => {
  it('calls client without throwing', async () => {
    const { updatePresence } = await import('./presence.ts');
    mockPresenceClient.updatePresence.mockResolvedValue({});

    await updatePresence(1); // PresenceStatus.ONLINE = 1
    expect(mockPresenceClient.updatePresence).toHaveBeenCalled();
  });

  it('swallows errors (logs to console)', async () => {
    const { updatePresence } = await import('./presence.ts');
    mockPresenceClient.updatePresence.mockRejectedValue(new Error('fail'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await updatePresence(1);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// getPresence
// ---------------------------------------------------------------------------
describe('getPresence', () => {
  it('updates store on success', async () => {
    const { getPresence } = await import('./presence.ts');
    mockPresenceClient.getPresence.mockResolvedValue({
      userId: 'u1',
      status: 1,
      statusText: 'Coding',
    });

    await getPresence('u1');
    const entry = usePresenceStore.getState().byUser.u1;
    expect(entry).toBeDefined();
    expect(entry?.statusText).toBe('Coding');
  });
});

// ---------------------------------------------------------------------------
// getBulkPresence
// ---------------------------------------------------------------------------
describe('getBulkPresence', () => {
  it('updates store for multiple users', async () => {
    const { getBulkPresence } = await import('./presence.ts');
    mockPresenceClient.getBulkPresence.mockResolvedValue({
      presences: [
        { userId: 'u1', status: 1, statusText: '' },
        { userId: 'u2', status: 2, statusText: 'AFK' },
      ],
    });

    await getBulkPresence(['u1', 'u2']);
    expect(usePresenceStore.getState().byUser.u1).toBeDefined();
    expect(usePresenceStore.getState().byUser.u2).toBeDefined();
  });

  it('skips call for empty user list', async () => {
    const { getBulkPresence } = await import('./presence.ts');
    await getBulkPresence([]);
    expect(mockPresenceClient.getBulkPresence).not.toHaveBeenCalled();
  });
});
