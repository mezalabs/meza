import { useContentWarningStore } from '../../stores/contentWarnings.ts';

interface ContentWarningInterstitialProps {
  channelId: string;
  channelName: string;
  contentWarning: string;
}

export function ContentWarningInterstitial({
  channelId,
  channelName,
  contentWarning,
}: ContentWarningInterstitialProps) {
  const dismiss = useContentWarningStore((s) => s.dismissChannel);

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-md space-y-4 text-center">
        <h2 className="text-lg font-semibold text-text">Content Warning</h2>
        <p className="text-sm text-text-muted">
          <span className="font-medium text-text">#{channelName}</span> has a
          content warning:
        </p>
        <div className="rounded-md border border-border bg-bg-surface px-4 py-3">
          <p className="text-sm text-text">{contentWarning}</p>
        </div>
        <button
          type="button"
          onClick={() => dismiss(channelId)}
          className="rounded-md bg-accent px-6 py-2 text-sm font-medium text-black transition-colors hover:bg-accent-hover"
        >
          I understand, show channel
        </button>
      </div>
    </div>
  );
}
