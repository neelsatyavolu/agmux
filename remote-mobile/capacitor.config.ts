import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Native iPhone shell around the remote PWA.
 * UI assets live in www/ (synced from remote-relay/public by `npm run sync-web`).
 * The PWA dials wss://remote.agmux.dev/ws when it isn't served over http(s).
 */
const BACKGROUND = '#0f1115'; // PWA dark --bg; avoids a colour flash between launch screen and UI

const config: CapacitorConfig = {
  appId: 'dev.agmux.remote',
  appName: 'agmux',
  webDir: 'www',
  backgroundColor: BACKGROUND,
  // Uncomment to load live site instead of bundled assets (dev only):
  // server: { url: 'https://remote.agmux.dev/', cleartext: false },
  ios: {
    // The PWA pads itself with env(safe-area-inset-*) (viewport-fit=cover).
    contentInset: 'never',
    preferredContentMode: 'mobile',
    backgroundColor: BACKGROUND,
    // The PWA is one fixed full-screen #stage with its own scroll areas; the
    // outer web view must not bounce or scroll when the keyboard opens.
    scrollEnabled: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 300,
      launchAutoHide: true,
      backgroundColor: BACKGROUND,
      showSpinner: false,
    },
    StatusBar: {
      style: 'DARK',
      overlaysWebView: true,
    },
    Keyboard: {
      // Shrink the web view so the fixed #stage (and its composer) sits above the keyboard.
      resize: 'native',
      resizeOnFullScreen: true,
    },
  },
};

export default config;
