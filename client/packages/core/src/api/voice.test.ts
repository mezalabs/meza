import { Code, ConnectError } from '@connectrpc/connect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the ConnectRPC voice client
// ---------------------------------------------------------------------------
const mockVoiceClient: Record<string, ReturnType<typeof vi.fn>> = {
  joinVoiceChannel: vi.fn(),
  leaveVoiceChannel: vi.fn(),
  getVoiceChannelState: vi.fn(),
};

vi.mock('@connectrpc/connect', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createClient: vi.fn(() => mockVoiceClient),
  };
});

vi.mock('./client.ts', () => ({
  transport: {},
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// joinVoiceChannel
// ---------------------------------------------------------------------------
describe('joinVoiceChannel', () => {
  it('calls client and returns response', async () => {
    const { joinVoiceChannel } = await import('./voice.ts');
    mockVoiceClient.joinVoiceChannel.mockResolvedValue({
      livekitUrl: 'wss://lk',
      livekitToken: 'tok',
    });

    const res = await joinVoiceChannel('ch1');
    expect(res.livekitUrl).toBe('wss://lk');
    expect(mockVoiceClient.joinVoiceChannel).toHaveBeenCalledWith({
      channelId: 'ch1',
    });
  });
});

// ---------------------------------------------------------------------------
// leaveVoiceChannel
// ---------------------------------------------------------------------------
describe('leaveVoiceChannel', () => {
  it('calls client', async () => {
    const { leaveVoiceChannel } = await import('./voice.ts');
    mockVoiceClient.leaveVoiceChannel.mockResolvedValue({});

    await leaveVoiceChannel('ch1');
    expect(mockVoiceClient.leaveVoiceChannel).toHaveBeenCalledWith({
      channelId: 'ch1',
    });
  });
});

// ---------------------------------------------------------------------------
// mapVoiceError
// ---------------------------------------------------------------------------
describe('mapVoiceError', () => {
  it('maps Unauthenticated', async () => {
    const { mapVoiceError } = await import('./voice.ts');
    expect(mapVoiceError(new ConnectError('no', Code.Unauthenticated))).toBe(
      'You must be logged in',
    );
  });

  it('maps PermissionDenied', async () => {
    const { mapVoiceError } = await import('./voice.ts');
    expect(mapVoiceError(new ConnectError('no', Code.PermissionDenied))).toBe(
      'You do not have access to this voice channel',
    );
  });

  it('maps NotFound', async () => {
    const { mapVoiceError } = await import('./voice.ts');
    expect(mapVoiceError(new ConnectError('no', Code.NotFound))).toBe(
      'Voice channel not found',
    );
  });

  it('maps non-ConnectError', async () => {
    const { mapVoiceError } = await import('./voice.ts');
    expect(mapVoiceError(new Error('random'))).toBe(
      'An unexpected error occurred',
    );
  });
});
