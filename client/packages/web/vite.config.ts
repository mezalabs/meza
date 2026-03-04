import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
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
    allowedHosts: ['.share.zrok.io'],
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
    },
  },
});
