import { getMediaURL } from '@meza/core';

type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

interface AvatarProps {
  avatarUrl?: string;
  displayName: string;
  size: AvatarSize;
  className?: string;
}

const sizeClasses: Record<AvatarSize, string> = {
  xs: 'h-5 w-5 text-[10px]',
  sm: 'h-6 w-6 text-xs',
  md: 'h-7 w-7 text-xs',
  lg: 'h-8 w-8 text-sm',
  xl: 'h-16 w-16 text-2xl',
};

/** Use thumbnail for small avatar sizes for performance. */
const useThumbnail: Record<AvatarSize, boolean> = {
  xs: true,
  sm: true,
  md: true,
  lg: false,
  xl: false,
};

/**
 * Build a renderable URL for an avatar.
 * If the stored URL is a `/media/{id}` path, convert it via getMediaURL
 * so the browser gets a presigned S3 URL with auth token.
 */
function resolveAvatarSrc(avatarUrl: string, size: AvatarSize): string {
  const match = avatarUrl.match(/^\/media\/([^/?]+)/);
  if (match) {
    return getMediaURL(match[1], useThumbnail[size]);
  }
  return avatarUrl;
}

export function Avatar({
  avatarUrl,
  displayName,
  size,
  className = '',
}: AvatarProps) {
  const sizeClass = sizeClasses[size];
  const initial = displayName?.[0]?.toUpperCase() ?? '?';

  if (avatarUrl) {
    return (
      <img
        src={resolveAvatarSrc(avatarUrl, size)}
        alt=""
        loading="lazy"
        className={`${sizeClass} flex-shrink-0 rounded-full object-cover ${className}`}
      />
    );
  }

  return (
    <div
      className={`${sizeClass} flex flex-shrink-0 items-center justify-center rounded-full bg-bg-surface font-medium text-text-muted ${className}`}
    >
      {initial}
    </div>
  );
}
