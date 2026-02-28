import type { DMChannel } from '@meza/gen/meza/v1/models_pb.ts';
import { ChannelType } from '@meza/gen/meza/v1/models_pb.ts';

/**
 * Returns a display name for a DM channel.
 * - For 1-on-1 DMs: returns the other participant's display name or username.
 * - For group DMs: returns the custom channel name if set, otherwise
 *   a comma-separated list of other participants' names.
 */
export function getDMDisplayName(dm: DMChannel, currentUserId: string): string {
  const isGroup = dm.channel?.type === ChannelType.GROUP_DM;
  const channelName = dm.channel?.name;

  if (isGroup && channelName && channelName !== 'Group DM') {
    return channelName;
  }

  const others = dm.participants.filter((p) => p.id !== currentUserId);
  if (others.length === 0) return 'Group DM';

  return others.map((p) => p.displayName || p.username).join(', ');
}

/**
 * Returns true if the DM channel is a group DM (type=4).
 */
export function isGroupDM(dm: DMChannel): boolean {
  return dm.channel?.type === ChannelType.GROUP_DM;
}
