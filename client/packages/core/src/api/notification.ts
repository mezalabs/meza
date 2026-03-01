import { createClient } from '@connectrpc/connect';
import { NotificationService } from '@meza/gen/meza/v1/notification_pb.ts';
import { transport } from './client.ts';

const notificationClient = createClient(NotificationService, transport);

export async function getNotificationPreferences() {
  const res = await notificationClient.getNotificationPreferences({});
  return res.preferences;
}

export async function updateNotificationPreference(
  scopeType: string,
  scopeId: string,
  level: string,
) {
  await notificationClient.updateNotificationPreference({
    scopeType,
    scopeId,
    level,
  });
}

export async function getVAPIDPublicKey(): Promise<string> {
  const res = await notificationClient.getVAPIDPublicKey({});
  return res.publicKey;
}
