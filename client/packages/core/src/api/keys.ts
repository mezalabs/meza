/**
 * KeyService API client.
 * Wraps KeyService RPCs for public key registration and channel key envelope management.
 */

import { KeyService } from '@meza/gen/meza/v1/keys_pb.ts';
import { createClient } from '@connectrpc/connect';
import { transport } from './client.ts';

const keysClient = createClient(KeyService, transport);

export async function registerPublicKey(
  signingPublicKey: Uint8Array,
): Promise<void> {
  await keysClient.registerPublicKey({ signingPublicKey });
}

export async function getPublicKeys(
  userIds: string[],
): Promise<Record<string, Uint8Array>> {
  const res = await keysClient.getPublicKeys({ userIds });
  return res.publicKeys;
}

export async function storeKeyEnvelopes(
  channelId: string,
  keyVersion: number,
  envelopes: Array<{ userId: string; envelope: Uint8Array }>,
): Promise<void> {
  await keysClient.storeKeyEnvelopes({ channelId, keyVersion, envelopes });
}

export async function getKeyEnvelopes(
  channelId: string,
): Promise<Array<{ keyVersion: number; envelope: Uint8Array }>> {
  const res = await keysClient.getKeyEnvelopes({ channelId });
  return res.envelopes.map((e) => ({
    keyVersion: e.keyVersion,
    envelope: e.envelope,
  }));
}

export async function listMembersWithViewChannel(
  channelId: string,
  cursor = '',
  limit = 1000,
): Promise<{
  members: Array<{ userId: string; signingPublicKey: Uint8Array }>;
  nextCursor: string;
}> {
  const res = await keysClient.listMembersWithViewChannel({
    channelId,
    cursor,
    limit,
  });
  return {
    members: res.members.map((m) => ({
      userId: m.userId,
      signingPublicKey: m.signingPublicKey,
    })),
    nextCursor: res.nextCursor,
  };
}

export async function rotateChannelKeyRpc(
  channelId: string,
  expectedVersion: number,
  envelopes: Array<{ userId: string; envelope: Uint8Array }>,
): Promise<number> {
  const res = await keysClient.rotateChannelKey({
    channelId,
    expectedVersion,
    envelopes,
  });
  return res.newVersion;
}
