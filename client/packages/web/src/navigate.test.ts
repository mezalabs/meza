import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSetPaneContent = vi.fn();
const mockSetPendingChannel = vi.fn();
const mockIsSessionReady = vi.fn<() => boolean>();
const mockIsAuthenticated = vi.fn<() => boolean>();

vi.mock('@meza/ui', () => ({
  useTilingStore: {
    getState: () => ({
      focusedPaneId: 'pane-1',
      setPaneContent: mockSetPaneContent,
    }),
  },
}));

vi.mock('@meza/core', () => ({
  isSessionReady: () => mockIsSessionReady(),
  setPendingChannel: (id: string) => mockSetPendingChannel(id),
  useAuthStore: {
    getState: () => ({ isAuthenticated: mockIsAuthenticated() }),
  },
}));

const { requestChannelNavigation } = await import('./navigate.ts');

beforeEach(() => {
  mockSetPaneContent.mockReset();
  mockSetPendingChannel.mockReset();
  mockIsSessionReady.mockReset();
  mockIsAuthenticated.mockReset();
});

describe('requestChannelNavigation', () => {
  it('drops the request when not authenticated (no navigate, no buffer)', () => {
    mockIsAuthenticated.mockReturnValue(false);
    mockIsSessionReady.mockReturnValue(true);

    requestChannelNavigation('chan-123');

    expect(mockSetPaneContent).not.toHaveBeenCalled();
    expect(mockSetPendingChannel).not.toHaveBeenCalled();
  });

  it('navigates immediately when authenticated and session is ready', () => {
    mockIsAuthenticated.mockReturnValue(true);
    mockIsSessionReady.mockReturnValue(true);

    requestChannelNavigation('chan-123');

    expect(mockSetPaneContent).toHaveBeenCalledWith('pane-1', {
      type: 'channel',
      channelId: 'chan-123',
    });
    expect(mockSetPendingChannel).not.toHaveBeenCalled();
  });

  it('buffers the channel id when authenticated but session is not ready', () => {
    mockIsAuthenticated.mockReturnValue(true);
    mockIsSessionReady.mockReturnValue(false);

    requestChannelNavigation('chan-123');

    expect(mockSetPaneContent).not.toHaveBeenCalled();
    expect(mockSetPendingChannel).toHaveBeenCalledWith('chan-123');
  });
});
