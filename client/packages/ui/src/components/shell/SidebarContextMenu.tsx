import type { PaneContent } from '@meza/core';
import { ackMessage, useMessageStore, useReadStateStore } from '@meza/core';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { type ReactNode, useEffect, useState } from 'react';
import {
  openChannelSettingsPane,
  useSimpleMode,
  useTilingStore,
} from '../../stores/tiling.ts';
import { ChannelMembersDialog } from './ChannelMembersDialog.tsx';

interface HoveredSplit {
  direction: 'horizontal' | 'vertical';
  before: boolean;
}

const GAP = 4;

function SplitPreviewOverlay({ hovered }: { hovered: HoveredSplit }) {
  const focusedPaneId = useTilingStore((s) => s.focusedPaneId);
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    const el = document.querySelector<HTMLElement>(
      `[data-pane-id="${focusedPaneId}"]`,
    );
    if (el) setRect(el.getBoundingClientRect());
  }, [focusedPaneId]);

  if (!rect) return null;

  const isH = hovered.direction === 'horizontal';
  const halfW = isH ? (rect.width - GAP) / 2 : rect.width;
  const halfH = isH ? rect.height : (rect.height - GAP) / 2;
  const top = !isH && !hovered.before ? rect.top + halfH + GAP : rect.top;
  const left = isH && !hovered.before ? rect.left + halfW + GAP : rect.left;

  return (
    <div
      style={{
        position: 'fixed',
        top,
        left,
        width: halfW,
        height: halfH,
      }}
      className="pointer-events-none rounded-lg bg-accent/8 border border-accent/25"
    />
  );
}

interface SidebarContextMenuProps {
  content: PaneContent;
  channelId?: string;
  channelName?: string;
  serverId?: string;
  isPrivate?: boolean;
  children: ReactNode;
}

export function SidebarContextMenu({
  content,
  channelId,
  channelName,
  serverId,
  isPrivate,
  children,
}: SidebarContextMenuProps) {
  const splitFocused = useTilingStore((s) => s.splitFocused);
  const [membersOpen, setMembersOpen] = useState(false);
  const [hoveredSplit, setHoveredSplit] = useState<HoveredSplit | null>(null);
  const simpleMode = useSimpleMode();

  const isChannel =
    (content.type === 'channel' || content.type === 'voice') &&
    channelId &&
    channelName;
  const unreadCount = useReadStateStore((s) =>
    channelId ? (s.byChannel[channelId]?.unreadCount ?? 0) : 0,
  );

  const handleMarkAsRead = () => {
    if (!channelId) return;
    const messages = useMessageStore.getState().byChannel[channelId];
    const lastMsg = messages?.[messages.length - 1];
    if (lastMsg) {
      // Optimistically clear the unread count locally before the RPC round-trip,
      // matching the keybind mark-channel-read behavior.
      useReadStateStore.getState().updateReadState(channelId, lastMsg.id, 0);
      ackMessage(channelId, lastMsg.id).catch(() => {});
    }
  };

  return (
    <>
      <ContextMenu.Root
        onOpenChange={(open) => {
          if (!open) setHoveredSplit(null);
        }}
      >
        <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="min-w-[180px] rounded-lg bg-bg-elevated p-1 shadow-lg animate-scale-in">
            {isChannel && unreadCount > 0 && (
              <>
                <ContextMenu.Item
                  className="cursor-default rounded-md px-3 py-1.5 text-sm text-text outline-none data-[highlighted]:bg-accent-subtle"
                  onSelect={handleMarkAsRead}
                >
                  Mark as Read
                </ContextMenu.Item>
                <ContextMenu.Separator className="my-1 h-px bg-border" />
              </>
            )}
            {isChannel && (
              <>
                {serverId && (
                  <ContextMenu.Item
                    className="cursor-default rounded-md px-3 py-1.5 text-sm text-text outline-none data-[highlighted]:bg-accent-subtle"
                    onSelect={() => {
                      if (channelId)
                        openChannelSettingsPane(serverId, channelId);
                    }}
                  >
                    Channel Settings
                  </ContextMenu.Item>
                )}
                {isPrivate && serverId && (
                  <ContextMenu.Item
                    className="cursor-default rounded-md px-3 py-1.5 text-sm text-text outline-none data-[highlighted]:bg-accent-subtle"
                    onSelect={() => setMembersOpen(true)}
                  >
                    Manage Members
                  </ContextMenu.Item>
                )}
                <ContextMenu.Separator className="my-1 h-px bg-border" />
              </>
            )}
            {!simpleMode && (
              <>
                <ContextMenu.Item
                  className="cursor-default rounded-md px-3 py-1.5 text-sm text-text outline-none data-[highlighted]:bg-accent-subtle"
                  onSelect={() => splitFocused('horizontal', content, true)}
                  asChild
                >
                  <div
                    onPointerEnter={() =>
                      setHoveredSplit({ direction: 'horizontal', before: true })
                    }
                    onPointerLeave={() => setHoveredSplit(null)}
                  >
                    Split left
                  </div>
                </ContextMenu.Item>
                <ContextMenu.Item
                  className="cursor-default rounded-md px-3 py-1.5 text-sm text-text outline-none data-[highlighted]:bg-accent-subtle"
                  onSelect={() => splitFocused('horizontal', content)}
                  asChild
                >
                  <div
                    onPointerEnter={() =>
                      setHoveredSplit({
                        direction: 'horizontal',
                        before: false,
                      })
                    }
                    onPointerLeave={() => setHoveredSplit(null)}
                  >
                    Split right
                  </div>
                </ContextMenu.Item>
                <ContextMenu.Item
                  className="cursor-default rounded-md px-3 py-1.5 text-sm text-text outline-none data-[highlighted]:bg-accent-subtle"
                  onSelect={() => splitFocused('vertical', content, true)}
                  asChild
                >
                  <div
                    onPointerEnter={() =>
                      setHoveredSplit({ direction: 'vertical', before: true })
                    }
                    onPointerLeave={() => setHoveredSplit(null)}
                  >
                    Split up
                  </div>
                </ContextMenu.Item>
                <ContextMenu.Item
                  className="cursor-default rounded-md px-3 py-1.5 text-sm text-text outline-none data-[highlighted]:bg-accent-subtle"
                  onSelect={() => splitFocused('vertical', content)}
                  asChild
                >
                  <div
                    onPointerEnter={() =>
                      setHoveredSplit({ direction: 'vertical', before: false })
                    }
                    onPointerLeave={() => setHoveredSplit(null)}
                  >
                    Split down
                  </div>
                </ContextMenu.Item>
              </>
            )}
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>

      {hoveredSplit && <SplitPreviewOverlay hovered={hoveredSplit} />}

      {isChannel && isPrivate && serverId && (
        <ChannelMembersDialog
          channelId={channelId}
          serverId={serverId}
          open={membersOpen}
          onOpenChange={setMembersOpen}
        />
      )}
    </>
  );
}
