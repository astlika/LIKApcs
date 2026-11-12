import type { CapacitorConfig } from '@capacitor/cli';

// Android APK wrapper for the phone app. The web build (`vite build --mode capacitor`) is packed
// into the APK; the API address is typed at sign-in (see src/native.ts).
const config: CapacitorConfig = {
  appId: 'com.likapcs.phone',
  appName: 'LIKApcs',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    // The LIKApcs Server is reached over Tailscale (http://100.x.y.z:4700); the WebView must allow it.
    allowMixedContent: true,
  },
};

export default config;
