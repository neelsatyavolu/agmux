import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Thin native shell around the remote PWA.
 * UI assets live in www/ (synced from xanom-website public/remote).
 * Control plane is still wss://agmux-remote-relay.xanom.workers.dev/ws.
 */
const config: CapacitorConfig = {
  appId: 'dev.agmux.remote',
  appName: 'agmux Remote',
  webDir: 'www',
  // Uncomment to load live site instead of bundled assets (dev only):
  // server: { url: 'https://remote.agmux.dev/', cleartext: false },
  ios: {
    contentInset: 'automatic',
    preferredContentMode: 'mobile',
    scheme: 'agmux-remote',
    backgroundColor: '#081410',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 400,
      backgroundColor: '#081410',
      showSpinner: false,
      launchAutoHide: true,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#081410',
    },
    Keyboard: {
      resize: 'body',
      resizeOnFullScreen: true,
    },
  },
};

export default config;
