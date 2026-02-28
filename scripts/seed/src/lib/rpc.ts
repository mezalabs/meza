import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { AuthService } from '../../../../client/gen/meza/v1/auth_pb.ts';
import type { SeedConfig } from './config.ts';

export function createAuthClient(config: SeedConfig) {
  const transport = createConnectTransport({
    baseUrl: `http://localhost:${config.authPort}`,
    httpVersion: '1.1',
  });

  return createClient(AuthService, transport);
}
