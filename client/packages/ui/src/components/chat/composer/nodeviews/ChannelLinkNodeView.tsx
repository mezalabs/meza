import { useChannelStore } from '@meza/core';
import { useNodeViewContext } from '@prosemirror-adapter/react';
import { memo } from 'react';
import type { ChannelLinkAttrs } from '../schema';

const ChannelLinkNodeView = memo(function ChannelLinkNodeView() {
  const { node, selected } = useNodeViewContext();
  const { id } = node.attrs as ChannelLinkAttrs;

  const channelName = useChannelStore((s) => {
    for (const channels of Object.values(s.byServer)) {
      const channel = channels.find((c) => c.id === id);
      if (channel) return channel.name;
    }
    return null;
  });

  return (
    <span
      className={`rounded px-0.5 bg-accent/15 text-accent ${
        selected ? 'ring-2 ring-accent/50' : ''
      }`}
      contentEditable={false}
    >
      {'\u200B'}
      <span style={{ display: 'inline-block' }}>
        #{channelName || 'deleted-channel'}
      </span>
      {'\u200B'}
    </span>
  );
});

export { ChannelLinkNodeView };
