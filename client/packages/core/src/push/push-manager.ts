import { createClient } from '@connectrpc/connect';
import { AuthService } from '@meza/gen/meza/v1/auth_pb.ts';
import { transport } from '../api/client.ts';
import type { PushAdapter } from './types.ts';

const authClient = createClient(AuthService, transport);

/**
 * Subscribe to push notifications using the provided platform adapter.
 * Registers the device with the server after obtaining push credentials.
 */
export async function subscribeToPush(adapter: PushAdapter): Promise<void> {
  const details = await adapter.subscribe();

  await authClient.registerDevice({
    devicePublicKey: new Uint8Array(0),
    deviceSignature: new Uint8Array(0),
    deviceName: adapter.deviceName,
    platform: adapter.platform,
    pushEndpoint: details?.pushEndpoint ?? '',
    pushP256dh: details?.pushP256dh ?? '',
    pushAuth: details?.pushAuth ?? '',
    pushToken: details?.pushToken ?? '',
  });
}
