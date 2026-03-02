import {
  type ComponentPropsWithoutRef,
  forwardRef,
  type ReactNode,
} from 'react';
import { ProfilePopoverCard } from '../profile/ProfilePopoverCard.tsx';

interface UserProfileTriggerProps extends ComponentPropsWithoutRef<'div'> {
  userId: string;
  serverId?: string;
  children: ReactNode;
}

/**
 * Wraps any avatar or username with a profile popover card.
 * Left-click opens the popover; right-click passes through to outer context menus.
 *
 * Forwards ref and spreads extra props so Radix `asChild` parents
 * (e.g. ContextMenu.Trigger) can attach handlers to the underlying DOM element.
 */
export const UserProfileTrigger = forwardRef<
  HTMLDivElement,
  UserProfileTriggerProps
>(function UserProfileTrigger({ userId, serverId, children, ...rest }, ref) {
  return (
    <ProfilePopoverCard userId={userId} serverId={serverId}>
      <div ref={ref} className="cursor-pointer" {...rest}>
        {children}
      </div>
    </ProfilePopoverCard>
  );
});
