import { getTwemojiUrl } from '@meza/core';
import { memo, useState } from 'react';

interface TwemojiImgProps {
  emoji: string;
  size?: number;
  className?: string;
}

/**
 * Renders a Unicode emoji as a Twemoji SVG image.
 * Falls back to the native Unicode character if the SVG fails to load.
 */
export const TwemojiImg = memo(function TwemojiImg({
  emoji,
  size = 24,
  className,
}: TwemojiImgProps) {
  const [fallback, setFallback] = useState(false);

  if (fallback) {
    return (
      <span
        className={`inline-block align-text-bottom leading-none ${className ?? ''}`}
        style={{ fontSize: size }}
      >
        {emoji}
      </span>
    );
  }

  return (
    <img
      src={getTwemojiUrl(emoji)}
      alt={emoji}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className={`inline-block align-text-bottom ${className ?? ''}`}
      onError={() => setFallback(true)}
    />
  );
});
