import type { CapacitorConfig } from '@capacitor/cli';

const devServer = process.env.CAPACITOR_DEV_SERVER;
const debug = !!devServer || !!process.env.CAPACITOR_DEBUG;

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
      backgroundColor: '#121212',
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
    webContentsDebuggingEnabled: debug,
  },
  ios: {
    webContentsDebuggingEnabled: debug,
  },
};

export default config;
