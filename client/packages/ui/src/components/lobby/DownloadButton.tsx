import { type DetectedOS, detectOS, isMobileOS } from '@meza/core';
import { useEffect, useState } from 'react';

const GITHUB_REPO = 'mezalabs/meza';
const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`;

/** Maps detected OS → asset filename suffix. */
const OS_ASSET_MAP: Record<string, { suffix: string; label: string }> = {
  macos: { suffix: 'mac-arm64.dmg', label: 'macOS' },
  windows: { suffix: 'win-x64.exe', label: 'Windows' },
  linux: { suffix: 'linux-x86_64.AppImage', label: 'Linux' },
};

const CACHE_KEY = 'meza-latest-desktop-release';
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

interface CachedRelease {
  version: string;
  timestamp: number;
}

function getCachedVersion(): string | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached: CachedRelease = JSON.parse(raw);
    if (Date.now() - cached.timestamp > CACHE_TTL) {
      sessionStorage.removeItem(CACHE_KEY);
      return null;
    }
    return cached.version;
  } catch {
    return null;
  }
}

function cacheVersion(version: string) {
  try {
    const entry: CachedRelease = { version, timestamp: Date.now() };
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    // sessionStorage unavailable — ignore
  }
}

async function fetchLatestDesktopVersion(): Promise<string | null> {
  const cached = getCachedVersion();
  if (cached) return cached;

  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases`,
      { headers: { Accept: 'application/vnd.github.v3+json' } },
    );
    if (!res.ok) return null;

    const releases: Array<{
      tag_name: string;
      draft: boolean;
      prerelease: boolean;
    }> = await res.json();

    // Find the first non-draft, non-prerelease desktop release
    const desktopRelease = releases.find(
      (r) => r.tag_name.startsWith('desktop-v') && !r.draft && !r.prerelease,
    );
    if (!desktopRelease) return null;

    // Extract version from "desktop-v0.0.8" → "0.0.8"
    const version = desktopRelease.tag_name.replace('desktop-v', '');
    cacheVersion(version);
    return version;
  } catch {
    return null;
  }
}

function buildDownloadUrl(version: string, os: DetectedOS): string {
  const asset = OS_ASSET_MAP[os];
  if (!asset) return RELEASES_URL;
  return `https://github.com/${GITHUB_REPO}/releases/download/desktop-v${version}/Meza-${version}-${asset.suffix}`;
}

export function DownloadButton() {
  const [os] = useState(() => detectOS());
  const [version, setVersion] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const mobile = isMobileOS(os);

  useEffect(() => {
    fetchLatestDesktopVersion()
      .then(setVersion)
      .finally(() => setLoading(false));
  }, []);

  const osLabel = mobile ? undefined : OS_ASSET_MAP[os]?.label;
  const hasDirectDownload = version && osLabel;

  return (
    <div className="flex flex-col items-center gap-2.5">
      {hasDirectDownload ? (
        <a
          href={buildDownloadUrl(version, os)}
          className="inline-flex w-full items-center justify-center rounded-lg bg-accent px-6 py-3.5 text-sm font-medium text-black transition-colors hover:bg-accent-hover"
        >
          Download for {osLabel}
        </a>
      ) : (
        <a
          href={RELEASES_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={`inline-flex w-full items-center justify-center rounded-lg bg-accent px-6 py-3.5 text-sm font-medium text-black transition-colors hover:bg-accent-hover ${loading ? 'opacity-70' : ''}`}
        >
          {loading ? 'Loading...' : 'Download Meza'}
        </a>
      )}

      <a
        href={RELEASES_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-text-muted transition-colors hover:text-text"
      >
        View all downloads
      </a>
    </div>
  );
}
