import { getMediaURL, useEmojiStore } from '@meza/core';
import { useNodeViewContext } from '@prosemirror-adapter/react';
import { memo, useCallback, useState } from 'react';
import type { CustomEmojiAttrs } from '../schema';

const CustomEmojiNodeView = memo(function CustomEmojiNodeView() {
  const { node } = useNodeViewContext();
  const { id, name } = node.attrs as CustomEmojiAttrs;

  const [errored, setErrored] = useState(false);

  // Resolve the media attachment ID from the emoji store (entity ID != attachment ID)
  const imageUrl = useEmojiStore((s) => {
    for (const emojis of Object.values(s.byServer)) {
      const emoji = emojis.find((e) => e.id === id);
      if (emoji) return emoji.imageUrl;
    }
    const personal = s.personal?.find((e) => e.id === id);
    return personal?.imageUrl ?? null;
  });

  const handleError = useCallback(() => {
    setErrored(true);
  }, []);

  if (errored || !imageUrl) {
    return (
      <span
        className="inline-block text-xs text-text-muted"
        contentEditable={false}
      >
        :{name}:
      </span>
    );
  }

  const attachmentId = imageUrl.replace('/media/', '');
  return (
    <img
      src={getMediaURL(attachmentId)}
      alt={`:${name}:`}
      className="inline-block h-5 w-5 object-contain align-text-bottom"
      draggable={false}
      contentEditable={false}
      onError={handleError}
    />
  );
});

export { CustomEmojiNodeView };
