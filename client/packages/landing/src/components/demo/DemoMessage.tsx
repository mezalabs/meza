import { useState } from 'react';
import { DemoAvatar } from './DemoAvatar';
import type { DemoMessage as DemoMessageType } from './types';

interface DemoMessageProps {
  message: DemoMessageType;
}

export function DemoMessage({ message }: DemoMessageProps) {
  const [reactions, setReactions] = useState(message.reactions ?? []);

  function toggleReaction(idx: number) {
    setReactions((prev) =>
      prev.map((r, i) =>
        i === idx
          ? {
              ...r,
              reacted: !r.reacted,
              count: r.reacted ? r.count - 1 : r.count + 1,
            }
          : r,
      ),
    );
  }

  return (
    <div className="group relative rounded-md px-2 py-1 transition-colors hover:bg-bg-surface/50">
      <div className="flex items-start gap-2">
        <div className="mt-0.5 flex-shrink-0">
          <DemoAvatar
            name={message.author.name}
            color={message.author.avatarColor}
            avatarUrl={message.author.avatarUrl}
          />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium text-text">
              {message.author.name}
            </span>
            <span className="text-xs text-text-subtle">
              {message.timestamp}
            </span>
          </div>

          <p className="text-sm leading-relaxed text-text-muted">
            {message.content}
          </p>

          {reactions.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {reactions.map((r, i) => (
                <button
                  key={r.emoji}
                  type="button"
                  onClick={() => toggleReaction(i)}
                  className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs transition-colors ${
                    r.reacted
                      ? 'border-accent/30 bg-accent/10 text-text hover:bg-accent/20'
                      : 'border-border bg-bg-surface text-text-muted hover:bg-bg-elevated'
                  }`}
                >
                  <span>{r.emoji}</span>
                  <span>{r.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Hover actions */}
      <div className="pointer-events-none absolute -top-2 right-4 flex items-center gap-0.5 rounded-md border border-border bg-bg-elevated px-1 py-0.5 opacity-0 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
        <button
          type="button"
          className="rounded p-1 text-text-muted hover:text-text"
          aria-label="React"
        >
          <svg
            aria-hidden="true"
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            fill="currentColor"
            viewBox="0 0 256 256"
          >
            <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216ZM80,108a12,12,0,1,1,12,12A12,12,0,0,1,80,108Zm96,0a12,12,0,1,1-12-12A12,12,0,0,1,176,108Zm-1.07,48c-10.29,17.79-27.4,28-46.93,28s-36.63-10.2-46.92-28a8,8,0,1,1,13.84-8c7.47,12.91,19.21,20,33.08,20s25.61-7.1,33.07-20a8,8,0,0,1,13.86,8Z" />
          </svg>
        </button>
        <button
          type="button"
          className="rounded p-1 text-text-muted hover:text-text"
          aria-label="Reply"
        >
          <svg
            aria-hidden="true"
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            fill="currentColor"
            viewBox="0 0 256 256"
          >
            <path d="M232,128a8,8,0,0,1-8,8H91.31l58.35,58.34a8,8,0,0,1-11.32,11.32l-72-72a8,8,0,0,1,0-11.32l72-72a8,8,0,0,1,11.32,11.32L91.31,120H224A8,8,0,0,1,232,128ZM40,32a8,8,0,0,0-8,8V216a8,8,0,0,0,16,0V40A8,8,0,0,0,40,32Z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
