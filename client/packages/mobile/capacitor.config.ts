import type { CapacitorConfig } from '@capacitor/cli';

const devServer = process.env.CAPACITOR_DEV_SERVER;

const config: CapacitorConfig = {
  appId: 'chat.meza.app',
  appName: 'Meza',
  webDir: '../web/dist',
  includePlugins: [
    '@capacitor/app',
    '@capacitor/push-notifications',
    '@capacitor/status-bar',
    '@capacitor/splash-screen',
  ],
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    SplashScreen: {
      launchShowDuration: 1500,
      launchAutoHide: true,
      backgroundColor: '#1a1a1a',
    },
  },
  server: devServer
    ? {
        url: devServer,
      }
    : {
        androidScheme: 'https',
      },
  android: {
    webContentsDebuggingEnabled: !!devServer,
  },
};

export default config;
