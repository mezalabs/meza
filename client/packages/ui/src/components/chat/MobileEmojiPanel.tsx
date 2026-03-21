import { memo } from 'react';
import { EmojiPicker } from './EmojiPicker.tsx';

interface MobileEmojiPanelProps {
  serverId?: string;
  panelHeight: number;
  onEmojiSelect: (text: string) => void;
  onSearchFocusChange: (focused: boolean) => void;
}

/**
 * Mobile-only emoji picker panel that replaces the keyboard.
 * Rendered inline below the composer in the ChannelView flex column.
 */
export const MobileEmojiPanel = memo(function MobileEmojiPanel({
  serverId,
  panelHeight,
  onEmojiSelect,
  onSearchFocusChange,
}: MobileEmojiPanelProps) {
  return (
    <div
      className="flex-shrink-0 bg-bg-elevated border-t border-border safe-bottom overflow-hidden"
      style={{ height: panelHeight }}
    >
      <EmojiPicker
        onEmojiSelect={onEmojiSelect}
        serverId={serverId}
        autoFocus={false}
        onSearchFocusChange={onSearchFocusChange}
      />
    </div>
  );
});
