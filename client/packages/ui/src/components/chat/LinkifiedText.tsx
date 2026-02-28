import { memo, useMemo } from 'react';

const URL_PATTERN = /https?:\/\/[^\s<>[\]`"]+/g;

interface LinkifiedTextProps {
  text: string;
}

/**
 * Renders text with HTTP/HTTPS URLs converted to clickable links.
 * Used as a wrapper around or instead of plain text rendering.
 */
export const LinkifiedText = memo(function LinkifiedText({
  text,
}: LinkifiedTextProps) {
  const parts = useMemo(() => {
    const result: (string | { url: string })[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    const regex = new RegExp(URL_PATTERN.source, 'g');

    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop pattern
    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        result.push(text.slice(lastIndex, match.index));
      }
      // Strip trailing punctuation that's likely sentence-ending.
      let url = match[0];
      while (url.length > 0 && /[.,);:\]']$/.test(url)) {
        url = url.slice(0, -1);
      }
      result.push({ url });
      // Adjust lastIndex to account for stripped chars.
      lastIndex = match.index + url.length;
      regex.lastIndex = lastIndex;
    }

    if (lastIndex < text.length) {
      result.push(text.slice(lastIndex));
    }

    return result;
  }, [text]);

  if (parts.length === 1 && typeof parts[0] === 'string') {
    return <>{text}</>;
  }

  return (
    <>
      {parts.map((part, i) => {
        if (typeof part === 'string') {
          // biome-ignore lint/suspicious/noArrayIndexKey: parts derived from regex splitting
          return <span key={i}>{part}</span>;
        }
        return (
          <a
            // biome-ignore lint/suspicious/noArrayIndexKey: parts derived from regex splitting
            key={i}
            href={part.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline"
          >
            {part.url}
          </a>
        );
      })}
    </>
  );
});
