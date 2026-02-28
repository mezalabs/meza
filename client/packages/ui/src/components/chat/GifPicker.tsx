import { useCallback, useEffect, useRef, useState } from 'react';

interface TenorGif {
  id: string;
  title: string;
  media_formats: {
    gif: { url: string; dims: [number, number] };
    tinygif: { url: string; dims: [number, number] };
  };
}

interface GifPickerProps {
  initialQuery: string;
  onSelect: (gifUrl: string) => void;
  onClose: () => void;
}

const TENOR_API_KEY = (
  import.meta as unknown as { env: Record<string, string | undefined> }
).env.VITE_TENOR_API_KEY;
const TENOR_SEARCH_URL = 'https://tenor.googleapis.com/v2/search';

export function GifPicker({ initialQuery, onSelect, onClose }: GifPickerProps) {
  const [query, setQuery] = useState(initialQuery);
  const [gifs, setGifs] = useState<TenorGif[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const search = useCallback(async (searchQuery: string) => {
    if (!TENOR_API_KEY) {
      setError('Tenor API key not configured (VITE_TENOR_API_KEY)');
      return;
    }
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      setGifs([]);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        q: trimmed,
        key: TENOR_API_KEY,
        limit: '20',
        media_filter: 'gif,tinygif',
        contentfilter: 'medium',
      });
      const res = await fetch(`${TENOR_SEARCH_URL}?${params}`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Tenor API error: ${res.status}`);
      const data = await res.json();
      setGifs(data.results ?? []);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError('Failed to search GIFs. Try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Search on mount with initial query.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional mount-only effect
  useEffect(() => {
    if (initialQuery.trim()) {
      search(initialQuery);
    }
    inputRef.current?.focus();
  }, []);

  // Debounced search on query change.
  useEffect(() => {
    const timeout = setTimeout(() => search(query), 300);
    return () => clearTimeout(timeout);
  }, [query, search]);

  // Escape to close.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  // Cleanup abort controller.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  return (
    <div className="absolute bottom-full left-0 z-50 mb-1 w-80 rounded-md border border-border bg-bg-elevated shadow-lg">
      {/* Search input */}
      <div className="border-b border-border p-2">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search GIFs..."
          className="w-full rounded-md border border-border bg-bg-surface px-2 py-1.5 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
      </div>

      {/* Results */}
      <div className="max-h-64 overflow-y-auto p-2">
        {error && (
          <div className="flex flex-col items-center gap-2 py-4">
            <span className="text-sm text-error">{error}</span>
            <button
              type="button"
              onClick={() => search(query)}
              className="text-xs text-accent hover:underline"
            >
              Retry
            </button>
          </div>
        )}

        {loading && gifs.length === 0 && !error && (
          <div className="py-4 text-center text-sm text-text-muted">
            Searching...
          </div>
        )}

        {!loading && !error && gifs.length === 0 && query.trim() && (
          <div className="py-4 text-center text-sm text-text-muted">
            No GIFs found
          </div>
        )}

        {!error && gifs.length > 0 && (
          <div className="grid grid-cols-2 gap-1">
            {gifs.map((gif) => (
              <button
                key={gif.id}
                type="button"
                className="overflow-hidden rounded-md hover:ring-2 hover:ring-accent transition-shadow"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(gif.media_formats.gif.url);
                }}
                title={gif.title || 'GIF'}
              >
                <img
                  src={gif.media_formats.tinygif.url}
                  alt={gif.title || 'GIF'}
                  className="h-24 w-full object-cover"
                  loading="lazy"
                />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
