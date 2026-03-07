import type { CapacitorConfig } from '@capacitor/cli';

const devServer = process.env.CAPACITOR_DEV_SERVER;

const config: CapacitorConfig = {
  appId: 'chat.meza.app',
  appName: 'Meza',
  webDir: '../web/dist',
  backgroundColor: '#121212',
  includePlugins: [
    '@capacitor/app',
    '@capacitor/keyboard',
    '@capacitor/push-notifications',
    '@capacitor/status-bar',
    '@capacitor/splash-screen',
  ],
  plugins: {
    Keyboard: {
      resize: 'native',
    },
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
        cleartext: true,
      }
    : {
        androidScheme: 'https',
        iosScheme: 'https',
      },
  android: {
    webContentsDebuggingEnabled: !!devServer,
  },
  ios: {
    webContentsDebuggingEnabled: !!devServer,
  },
};

export default config;
