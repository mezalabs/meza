import { getMediaURL } from '@meza/core';
import { memo } from 'react';
import { useMobile } from '../../hooks/useMobile.ts';

export interface PreviewEmoji {
  type: 'custom' | 'unicode';
  display: string; // native character or image URL attachment ID
  name: string;
  source: string; // "Personal", server name, or Unicode category label
  animated?: boolean;
}

interface EmojiPickerPreviewProps {
  emoji: PreviewEmoji | null;
}

export const EmojiPickerPreview = memo(function EmojiPickerPreview({
  emoji,
}: EmojiPickerPreviewProps) {
  const isMobile = useMobile();
  if (isMobile) return null;

  return (
    <div className="flex items-center gap-2 border-t border-border px-3 py-1.5 h-10">
      {emoji ? (
        <>
          <div className="flex-shrink-0 flex items-center justify-center w-7 h-7">
            {emoji.type === 'custom' ? (
              <img
                src={getMediaURL(emoji.display)}
                alt={`:${emoji.name}:`}
                className="h-7 w-7 object-contain"
              />
            ) : (
              <span className="text-2xl leading-none">{emoji.display}</span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <span className="text-sm font-medium text-text truncate block">
              :{emoji.name}:
            </span>
            {emoji.source && (
              <span className="text-xs text-text-muted truncate block">
                {emoji.source}
              </span>
            )}
          </div>
        </>
      ) : (
        <span className="text-xs text-text-subtle">
          Hover an emoji to preview
        </span>
      )}
    </div>
  );
});
