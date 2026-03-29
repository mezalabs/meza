interface DemoComposerProps {
  channelName: string;
}

export function DemoComposer({ channelName }: DemoComposerProps) {
  return (
    <div className="border-t border-border px-4 py-3">
      <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-elevated px-3 py-2.5">
        <button
          type="button"
          className="flex-shrink-0 text-text-muted hover:text-text"
          aria-label="Attach file"
        >
          <svg
            aria-hidden="true"
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            fill="currentColor"
            viewBox="0 0 256 256"
          >
            <path d="M209.66,122.34a8,8,0,0,1,0,11.32l-82.05,82a56,56,0,0,1-79.2-79.21L147.67,35.73a40,40,0,1,1,56.61,56.55L105,193.05A24,24,0,1,1,71,159.05l74.34-74.34a8,8,0,0,1,11.32,11.32L82.27,170.37a8,8,0,1,0,11.36,11.31L192.89,80.94a24,24,0,0,0-33.95-33.95L59.67,147.73a40,40,0,0,0,56.61,56.55L198.34,122.34A8,8,0,0,1,209.66,122.34Z" />
          </svg>
        </button>
        <input
          type="text"
          placeholder={`Message #${channelName}`}
          className="flex-1 bg-transparent text-sm text-text placeholder:text-text-subtle outline-none"
          aria-label={`Message ${channelName}`}
        />
        <button
          type="button"
          className="flex-shrink-0 text-text-muted hover:text-text"
          aria-label="Send message"
        >
          <svg
            aria-hidden="true"
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            fill="currentColor"
            viewBox="0 0 256 256"
          >
            <path d="M231.87,114,25.66,14.16a8,8,0,0,0-11,9.48L36.29,120H136a8,8,0,0,1,0,16H36.29L14.63,232.36A8,8,0,0,0,22,240a8.14,8.14,0,0,0,3.68-.89L231.87,142A16,16,0,0,0,231.87,114Z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
