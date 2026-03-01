import { Code, ConnectError, createClient } from '@connectrpc/connect';
import {
  PresenceService,
  PresenceStatus,
} from '@meza/gen/meza/v1/presence_pb.ts';
import { usePresenceStore } from '../store/presence.ts';
import { transport } from './client.ts';

const presenceClient = createClient(PresenceService, transport);

function mapPresenceError(err: unknown): string {
  if (err instanceof ConnectError) {
    switch (err.code) {
      case Code.PermissionDenied:
        return 'You do not have access';
      case Code.NotFound:
        return 'Not found';
      case Code.InvalidArgument:
        return err.message;
      default:
        return 'Something went wrong. Please try again.';
    }
  }
  return 'Network error. Please check your connection.';
}

export async function updatePresence(
  status: PresenceStatus,
  statusText?: string,
) {
  try {
    await presenceClient.updatePresence({ status, statusText });
  } catch (err) {
    console.error('Failed to update presence:', mapPresenceError(err));
  }
}

export async function getPresence(userId: string) {
  try {
    const res = await presenceClient.getPresence({ userId });
    usePresenceStore
      .getState()
      .setPresence(res.userId, res.status, res.statusText);
    return res;
  } catch (err) {
    console.error('Failed to get presence:', mapPresenceError(err));
    throw err;
  }
}

export async function getBulkPresence(userIds: string[]) {
  if (userIds.length === 0) return;
  try {
    const res = await presenceClient.getBulkPresence({ userIds });
    usePresenceStore.getState().setBulkPresence(
      res.presences.map((p) => ({
        userId: p.userId,
        status: p.status,
        statusText: p.statusText,
      })),
    );
    return res.presences;
  } catch (err) {
    console.error('Failed to get bulk presence:', mapPresenceError(err));
    throw err;
  }
}

export async function setStatusOverride(
  status: PresenceStatus,
  durationSeconds = 0,
) {
  try {
    const res = await presenceClient.setStatusOverride({
      status,
      durationSeconds: BigInt(durationSeconds),
    });
    const store = usePresenceStore.getState();
    store.setMyOverride({
      status: res.status,
      expiresAt: Number(res.expiresAt),
    });
    store.setMyStatus(status);
    return res;
  } catch (err) {
    console.error('Failed to set status override:', mapPresenceError(err));
    throw err;
  }
}

export async function clearStatusOverride() {
  try {
    await presenceClient.clearStatusOverride({});
    usePresenceStore.getState().setMyOverride(null);
    // Sync real status from server rather than assuming ONLINE
    await getMyPresence();
  } catch (err) {
    console.error('Failed to clear status override:', mapPresenceError(err));
    throw err;
  }
}

export async function getMyPresence() {
  try {
    const res = await presenceClient.getMyPresence({});
    const store = usePresenceStore.getState();
    if (res.overrideStatus !== PresenceStatus.UNSPECIFIED) {
      store.setMyOverride({
        status: res.overrideStatus,
        expiresAt: Number(res.overrideExpiresAt),
      });
      store.setMyStatus(res.overrideStatus);
    } else {
      store.setMyOverride(null);
      store.setMyStatus(res.status);
    }
    return res;
  } catch (err) {
    console.error('Failed to get my presence:', mapPresenceError(err));
    return undefined;
  }
}
