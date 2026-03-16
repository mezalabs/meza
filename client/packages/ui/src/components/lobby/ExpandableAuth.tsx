import { useCallback, useRef, useState } from 'react';
import { AuthForm } from './AuthForm.tsx';

export function ExpandableAuth() {
  const [expanded, setExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const handleExpand = useCallback(() => {
    setExpanded(true);
    // Scroll the auth form into view after the CSS transition starts
    requestAnimationFrame(() => {
      contentRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    });
  }, []);

  return (
    <div className="flex flex-col items-center">
      {!expanded && (
        <button
          type="button"
          onClick={handleExpand}
          aria-expanded={expanded}
          className="w-full rounded-lg border border-border bg-bg-surface px-6 py-3.5 text-sm font-medium text-text-muted transition-colors hover:border-border-hover hover:text-text"
        >
          Continue in browser &rsaquo;
        </button>
      )}

      <div
        ref={contentRef}
        className="w-full"
        style={{
          display: 'grid',
          gridTemplateRows: expanded ? '1fr' : '0fr',
          transition: 'grid-template-rows 300ms cubic-bezier(0.2, 0, 0, 1)',
        }}
      >
        <div className="overflow-hidden">
          <div className="pt-4">
            <AuthForm />
          </div>
        </div>
      </div>
    </div>
  );
}
