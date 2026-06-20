import { createClient, type Interceptor } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { AuthService } from '../../../../client/gen/meza/v1/auth_pb.ts';
import { ChatService } from '../../../../client/gen/meza/v1/chat_pb.ts';
import { KeyService } from '../../../../client/gen/meza/v1/keys_pb.ts';
import type { SeedConfig } from './config.ts';

export function createAuthClient(config: SeedConfig) {
  const transport = createConnectTransport({
    baseUrl: `http://localhost:${config.authPort}`,
    httpVersion: '1.1',
  });

  return createClient(AuthService, transport);
}

/**
 * Create an authenticated interceptor that adds a Bearer token to every request.
 */
function authInterceptor(token: string): Interceptor {
  return (next) => (req) => {
    req.header.set('Authorization', `Bearer ${token}`);
    return next(req);
  };
}

export function createChatClient(config: SeedConfig, token: string) {
  const transport = createConnectTransport({
    baseUrl: `http://localhost:${config.chatPort}`,
    httpVersion: '1.1',
    interceptors: [authInterceptor(token)],
  });

  return createClient(ChatService, transport);
}

export function createKeyClient(config: SeedConfig, token: string) {
  const transport = createConnectTransport({
    baseUrl: `http://localhost:${config.keyPort}`,
    httpVersion: '1.1',
    interceptors: [authInterceptor(token)],
  });

  return createClient(KeyService, transport);
}
