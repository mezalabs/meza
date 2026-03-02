import type { ReactNode } from 'react';
import { ProfilePopoverCard } from '../profile/ProfilePopoverCard.tsx';

interface UserProfileTriggerProps {
  userId: string;
  serverId?: string;
  children: ReactNode;
}

/**
 * Wraps any avatar or username with a profile popover card.
 * Left-click opens the popover; right-click still opens the context menu.
 */
export function UserProfileTrigger({
  userId,
  serverId,
  children,
}: UserProfileTriggerProps) {
  return (
    <ProfilePopoverCard userId={userId} serverId={serverId}>
      <button type="button" className="cursor-pointer">
        {children}
      </button>
    </ProfilePopoverCard>
  );
}
