import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireBlobURL,
  releaseAllBlobURLs,
  releaseBlobURL,
} from './blob-urls.ts';

// Spy on URL.createObjectURL and URL.revokeObjectURL
const createSpy = vi.spyOn(URL, 'createObjectURL');
const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');

afterEach(() => {
  releaseAllBlobURLs();
  vi.clearAllMocks();
});

describe('acquireBlobURL', () => {
  it('creates a blob URL on first acquire', () => {
    const blob = new Blob(['test']);
    createSpy.mockReturnValue('blob:test-url');

    const url = acquireBlobURL('key-1', blob);
    expect(url).toBe('blob:test-url');
    expect(createSpy).toHaveBeenCalledOnce();
  });

  it('reuses existing URL on subsequent acquires', () => {
    const blob = new Blob(['test']);
    createSpy.mockReturnValue('blob:test-url');

    const url1 = acquireBlobURL('key-1', blob);
    const url2 = acquireBlobURL('key-1', blob);
    expect(url1).toBe(url2);
    expect(createSpy).toHaveBeenCalledOnce();
  });
});

describe('releaseBlobURL', () => {
  it('revokes when refcount reaches zero', () => {
    const blob = new Blob(['test']);
    createSpy.mockReturnValue('blob:test-url');

    acquireBlobURL('key-1', blob);
    releaseBlobURL('key-1');

    expect(revokeSpy).toHaveBeenCalledWith('blob:test-url');
  });

  it('does not revoke when refs remain', () => {
    const blob = new Blob(['test']);
    createSpy.mockReturnValue('blob:test-url');

    acquireBlobURL('key-1', blob);
    acquireBlobURL('key-1', blob); // refCount = 2
    releaseBlobURL('key-1'); // refCount = 1

    expect(revokeSpy).not.toHaveBeenCalled();
  });

  it('revokes after all refs released', () => {
    const blob = new Blob(['test']);
    createSpy.mockReturnValue('blob:test-url');

    acquireBlobURL('key-1', blob);
    acquireBlobURL('key-1', blob);
    releaseBlobURL('key-1');
    releaseBlobURL('key-1');

    expect(revokeSpy).toHaveBeenCalledWith('blob:test-url');
  });

  it('is a no-op for unknown keys', () => {
    releaseBlobURL('nonexistent');
    expect(revokeSpy).not.toHaveBeenCalled();
  });
});

describe('releaseAllBlobURLs', () => {
  it('revokes all managed URLs', () => {
    const blob = new Blob(['test']);
    createSpy
      .mockReturnValueOnce('blob:url-1')
      .mockReturnValueOnce('blob:url-2');

    acquireBlobURL('key-1', blob);
    acquireBlobURL('key-2', blob);

    releaseAllBlobURLs();

    expect(revokeSpy).toHaveBeenCalledWith('blob:url-1');
    expect(revokeSpy).toHaveBeenCalledWith('blob:url-2');
  });

  it('clears the map so subsequent acquires create fresh URLs', () => {
    const blob = new Blob(['test']);
    createSpy.mockReturnValueOnce('blob:old').mockReturnValueOnce('blob:new');

    acquireBlobURL('key-1', blob);
    releaseAllBlobURLs();

    const url = acquireBlobURL('key-1', blob);
    expect(url).toBe('blob:new');
    expect(createSpy).toHaveBeenCalledTimes(2);
  });
});
