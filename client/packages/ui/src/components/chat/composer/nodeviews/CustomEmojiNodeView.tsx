import { getMediaURL } from '@meza/core';
import { useNodeViewContext } from '@prosemirror-adapter/react';
import { memo, useCallback, useState } from 'react';
import type { CustomEmojiAttrs } from '../schema';

const CustomEmojiNodeView = memo(function CustomEmojiNodeView() {
  const { node } = useNodeViewContext();
  const { id, name } = node.attrs as CustomEmojiAttrs;

  const [errored, setErrored] = useState(false);

  const handleError = useCallback(() => {
    setErrored(true);
  }, []);

  if (errored) {
    return (
      <span
        className="inline-block text-xs text-muted-foreground"
        contentEditable={false}
      >
        {'\u200B'}:{name}:{'\u200B'}
      </span>
    );
  }

  return (
    <img
      src={getMediaURL(id)}
      alt={`:${name}:`}
      className="inline-block h-5 w-5 object-contain align-text-bottom"
      draggable={false}
      contentEditable={false}
      onError={handleError}
    />
  );
});

export { CustomEmojiNodeView };
