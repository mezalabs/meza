import { getMediaURL, useEmojiStore } from '@meza/core';
import { TwemojiImg } from '../shared/TwemojiImg.tsx';

const CUSTOM_EMOJI_RE = /^<(a?):([a-z0-9_]{2,32}):([a-zA-Z0-9]+)>$/;

interface EmojiDisplayProps {
  emoji: string;
  serverId?: string;
  /** CSS class for the img element. Defaults to "inline-block h-4.5 w-4.5 object-contain". */
  imgClassName?: string;
  /** Font size for native Unicode emoji. Defaults to 18. */
  fontSize?: number;
}

/**
 * Renders an emoji string — either a native Unicode emoji or a custom emoji image.
 * Looks up custom emojis across all sources: current server, other servers,
 * personal emojis, and reaction-enriched emojis (byId).
 */
export function EmojiDisplay({
  emoji,
  serverId,
  imgClassName = 'inline-block h-4.5 w-4.5 object-contain',
  fontSize = 18,
}: EmojiDisplayProps) {
  const match = CUSTOM_EMOJI_RE.exec(emoji);
  const custom = useEmojiStore((s) => {
    if (!match) return undefined;
    const id = match[3];
    // 1. Current server (fast path, most common)
    if (serverId) {
      const found = s.byServer[serverId]?.find((e) => e.id === id);
      if (found) return found;
    }
    // 2. Other loaded servers
    for (const [sid, list] of Object.entries(s.byServer)) {
      if (sid === serverId) continue;
      const found = list.find((e) => e.id === id);
      if (found) return found;
    }
    // 3. Personal emojis
    const personal = s.personal?.find((e) => e.id === id);
    if (personal) return personal;
    // 4. Reaction-enriched emojis (foreign emojis from server responses)
    return s.byId[id];
  });

  if (match) {
    const [, , name] = match;
    if (custom) {
      const attachmentId = custom.imageUrl.replace('/media/', '');
      return (
        <img
          src={getMediaURL(attachmentId)}
          alt={`:${name}:`}
          className={imgClassName}
          loading="lazy"
        />
      );
    }
    return <span>:{name}:</span>;
  }

  return <TwemojiImg emoji={emoji} size={fontSize} />;
}
