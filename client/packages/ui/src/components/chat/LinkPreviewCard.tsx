import type { LinkEmbed } from '@meza/core';
import { memo } from 'react';

interface LinkPreviewCardProps {
  embed: LinkEmbed;
}

export const LinkPreviewCard = memo(function LinkPreviewCard({
  embed,
}: LinkPreviewCardProps) {
  const hasImage = embed.imageUrl !== '';
  const hasTitle = embed.title !== '';
  const hasDescription = embed.description !== '';

  if (!hasTitle && !hasDescription) return null;

  return (
    <a
      href={embed.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group mt-1 flex max-w-md overflow-hidden rounded-lg border border-border bg-bg-secondary hover:bg-bg-tertiary transition-colors"
    >
      {hasImage && (
        <div className="flex-shrink-0 w-20 bg-bg-tertiary">
          <img
            src={embed.imageUrl}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
          />
        </div>
      )}
      <div className="flex flex-col justify-center gap-0.5 px-3 py-2 min-w-0">
        {embed.siteName && (
          <span className="text-xs text-text-muted truncate">
            {embed.siteName}
          </span>
        )}
        {hasTitle && (
          <span className="text-sm font-medium text-accent group-hover:underline truncate">
            {embed.title}
          </span>
        )}
        {hasDescription && (
          <span className="text-xs text-text-muted line-clamp-2">
            {embed.description}
          </span>
        )}
        {embed.domain && !embed.siteName && (
          <span className="text-xs text-text-subtle truncate">
            {embed.domain}
          </span>
        )}
      </div>
    </a>
  );
});
