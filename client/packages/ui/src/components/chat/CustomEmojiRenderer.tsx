import { getMediaURL, useAuthStore, useEmojiStore } from '@meza/core';
import { memo, useCallback, useMemo, useState } from 'react';

const EMOJI_PATTERN = /<(a?):([a-z0-9_]{2,32}):([a-zA-Z0-9]+)>/g;

interface CustomEmojiRendererProps {
  text: string;
  serverId: string;
}

export const CustomEmojiRenderer = memo(function CustomEmojiRenderer({
  text,
  serverId,
}: CustomEmojiRendererProps) {
  const emojis = useEmojiStore((s) => s.byServer[serverId]);
  const emojiScale = useAuthStore((s) => s.user?.emojiScale ?? 1);
  const [failedIds, setFailedIds] = useState<Set<string>>(new Set());

  const handleError = useCallback((id: string) => {
    setFailedIds((prev) => new Set(prev).add(id));
  }, []);

  const parts = useMemo(() => {
    const result: (string | { id: string; name: string; animated: boolean })[] =
      [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    const regex = new RegExp(EMOJI_PATTERN.source, 'g');

    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop pattern
    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        result.push(text.slice(lastIndex, match.index));
      }
      result.push({
        animated: match[1] === 'a',
        name: match[2],
        id: match[3],
      });
      lastIndex = regex.lastIndex;
    }

    if (lastIndex < text.length) {
      result.push(text.slice(lastIndex));
    }

    return result;
  }, [text]);

  return (
    <>
      {parts.map((part, i) => {
        if (typeof part === 'string') return part;
        const emoji = emojis?.find((e) => e.id === part.id);
        if (!emoji || failedIds.has(part.id)) return `:${part.name}:`;
        const attachmentId = emoji.imageUrl.replace('/media/', '');
        const size = 20 * emojiScale;
        return (
          <img
            // biome-ignore lint/suspicious/noArrayIndexKey: parts are derived from regex splitting, no stable key available
            key={i}
            src={getMediaURL(attachmentId)}
            alt={`:${part.name}:`}
            title={`:${part.name}:`}
            className="inline-block align-text-bottom"
            style={{ width: size, height: size }}
            loading="lazy"
            onError={() => handleError(part.id)}
          />
        );
      })}
    </>
  );
});
