import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mobileDev = !!process.env.MOBILE_DEV;

export default defineConfig(async () => {
  // Use Tailscale HTTPS cert for mobile dev so the WebView gets a secure
  // context (required for crypto.subtle) with a real trusted certificate.
  let https: undefined | { cert: Buffer; key: Buffer };
  if (mobileDev) {
    const certsDir = resolve(__dirname, '../mobile/.certs');
    https = {
      cert: readFileSync(resolve(certsDir, 'dev.pem')),
      key: readFileSync(resolve(certsDir, 'dev-key.pem')),
    };
  }

  return {
    plugins: [tailwindcss(), react()],
    resolve: {
      dedupe: ['@phosphor-icons/react', 'react', 'react-dom'],
    },
    optimizeDeps: {
      exclude: ['@jitsi/rnnoise-wasm'],
    },
    server: {
      port: 4080,
      host: true,
      https,
      allowedHosts: ['.share.zrok.io', '.ts.net'],
      proxy: {
        // Auth service → server/cmd/auth (port 8081)
        '/meza.v1.AuthService': {
          target: 'http://localhost:8081',
          changeOrigin: true,
        },
        // Federation service → server/cmd/auth (port 8081)
        '/meza.v1.FederationService': {
          target: 'http://localhost:8081',
          changeOrigin: true,
        },
        // Chat service → server/cmd/chat (port 8082)
        '/meza.v1.ChatService': {
          target: 'http://localhost:8082',
          changeOrigin: true,
        },
        // Presence service → server/cmd/presence (port 8083)
        '/meza.v1.PresenceService': {
          target: 'http://localhost:8083',
          changeOrigin: true,
        },
        // Media service → server/cmd/media (port 8084)
        '/meza.v1.MediaService': {
          target: 'http://localhost:8084',
          changeOrigin: true,
        },
        '/media': {
          target: 'http://localhost:8084',
          changeOrigin: true,
        },
        // Voice service → server/cmd/voice (port 8085)
        '/meza.v1.VoiceService': {
          target: 'http://localhost:8085',
          changeOrigin: true,
        },
        // Notification service → server/cmd/notification (port 8086)
        '/meza.v1.NotificationService': {
          target: 'http://localhost:8086',
          changeOrigin: true,
        },
        // Key distribution service → server/cmd/keys (port 8088)
        '/meza.v1.KeyService': {
          target: 'http://localhost:8088',
          changeOrigin: true,
        },
        // Gateway WebSocket → server/cmd/gateway (port 8080)
        '/ws': {
          target: 'ws://localhost:8080',
          ws: true,
        },
        // Mobile dev: proxy plain-HTTP services through Vite's HTTPS to
        // avoid mixed-content / ERR_SSL_PROTOCOL_ERROR on the phone.
        ...(mobileDev
          ? {
              // S3/MinIO — changeOrigin must be false so the Host header
              // matches the Host signed in the presigned URL.
              '/meza-media': {
                target: 'http://localhost:9000',
              },
              // LiveKit — HTTP validation + WebSocket signaling.
              '/rtc': {
                target: 'http://localhost:7880',
                ws: true,
              },
            }
          : {}),
      },
    },
  };
});
