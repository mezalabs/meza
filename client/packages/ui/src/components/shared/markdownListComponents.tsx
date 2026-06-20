import type { ComponentPropsWithoutRef } from 'react';

/**
 * react-markdown element handlers for lists.
 *
 * Kept in their own module (free of app/store dependencies) so the rendering
 * contract can be unit-tested in isolation. See MarkdownRenderer.test.tsx.
 */
export const markdownListComponents = {
  ul: ({ children }: ComponentPropsWithoutRef<'ul'>) => (
    <ul className="my-1 ml-4 list-disc space-y-0.5">{children}</ul>
  ),
  // Forward `start` so an ordered list keeps the number the author actually
  // typed. Without this, "4. is a good point" renders as "1. ...".
  ol: ({ children, start }: ComponentPropsWithoutRef<'ol'>) => (
    <ol start={start} className="my-1 ml-4 list-decimal space-y-0.5">
      {children}
    </ol>
  ),
  li: ({ children, className }: ComponentPropsWithoutRef<'li'>) => {
    // Task list items get a special class from remark-gfm.
    const isTask = className?.includes('task-list-item');
    return (
      <li className={isTask ? 'list-none -ml-4 flex items-start gap-1.5' : ''}>
        {children}
      </li>
    );
  },
};
