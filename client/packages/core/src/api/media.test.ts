import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the ConnectRPC media client
// ---------------------------------------------------------------------------
const mockMediaClient: Record<string, ReturnType<typeof vi.fn>> = {
  createUpload: vi.fn(),
  completeUpload: vi.fn(),
  getDownloadURL: vi.fn(),
};

vi.mock('@connectrpc/connect', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createClient: vi.fn(() => mockMediaClient),
  };
});

vi.mock('./client.ts', () => ({
  transport: {},
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// createUpload
// ---------------------------------------------------------------------------
describe('createUpload', () => {
  it('returns uploadId and uploadUrl', async () => {
    const { createUpload } = await import('./media.ts');
    mockMediaClient.createUpload.mockResolvedValue({
      uploadId: 'up1',
      uploadUrl: 'https://s3.example.com/up1',
    });

    const result = await createUpload('file.png', 'image/png', 1024, 0);
    expect(result.uploadId).toBe('up1');
    expect(result.uploadUrl).toBe('https://s3.example.com/up1');
  });
});

// ---------------------------------------------------------------------------
// completeUpload
// ---------------------------------------------------------------------------
describe('completeUpload', () => {
  it('returns attachment details', async () => {
    const { completeUpload } = await import('./media.ts');
    mockMediaClient.completeUpload.mockResolvedValue({
      attachmentId: 'att1',
      url: '/media/att1',
      hasThumbnail: true,
      width: 800,
      height: 600,
      microThumbnail: new Uint8Array([1, 2, 3]),
    });

    const result = await completeUpload('up1');
    expect(result.attachmentId).toBe('att1');
    expect(result.url).toBe('/media/att1');
    expect(result.hasThumbnail).toBe(true);
    expect(result.width).toBe(800);
    expect(result.height).toBe(600);
    expect(result.microThumbnail).toEqual(new Uint8Array([1, 2, 3]));
  });
});

// ---------------------------------------------------------------------------
// getDownloadURL
// ---------------------------------------------------------------------------
describe('getDownloadURL', () => {
  it('returns the URL', async () => {
    const { getDownloadURL } = await import('./media.ts');
    mockMediaClient.getDownloadURL.mockResolvedValue({
      url: 'https://cdn.example.com/file.png',
    });

    const url = await getDownloadURL('att1');
    expect(url).toBe('https://cdn.example.com/file.png');
  });

  it('passes thumbnail flag', async () => {
    const { getDownloadURL } = await import('./media.ts');
    mockMediaClient.getDownloadURL.mockResolvedValue({ url: '/thumb' });

    await getDownloadURL('att1', true);
    expect(mockMediaClient.getDownloadURL).toHaveBeenCalledWith({
      attachmentId: 'att1',
      thumbnail: true,
    });
  });
});

// ---------------------------------------------------------------------------
// getMediaURL (synchronous helper)
// ---------------------------------------------------------------------------
describe('getMediaURL', () => {
  it('returns media path', async () => {
    const { getMediaURL } = await import('./media.ts');
    expect(getMediaURL('att1')).toBe('/media/att1');
  });

  it('returns thumbnail path', async () => {
    const { getMediaURL } = await import('./media.ts');
    expect(getMediaURL('att1', true)).toBe('/media/att1/thumb');
  });
});
