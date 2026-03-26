interface DemoMessageProps {
  author: string;
  timestamp: string;
  children: React.ReactNode;
}

function AuthorAvatar({ name }: { name: string }) {
  return (
    <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-accent text-xs font-bold text-black">
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

export function DemoMessage({ author, timestamp, children }: DemoMessageProps) {
  return (
    <div className="group flex items-start gap-2 px-4 py-1 hover:bg-bg-surface/50">
      <AuthorAvatar name={author} />
      <div className="min-w-0 flex-1 select-text">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-text">{author}</span>
          <span className="text-xs text-text-subtle">{timestamp}</span>
        </div>
        <div className="text-sm text-text leading-relaxed">{children}</div>
      </div>
    </div>
  );
}
