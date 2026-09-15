import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Phase 1 generates the native folders but builds neither (HANDOFF.md). The iOS build
 * is a Mac step; an Android debug APK is possible on Linux with the SDK present but is
 * explicitly not a gate.
 */
const config: CapacitorConfig = {
  appId: 'co.egen.tcmarker',
  appName: 'tc-marker',
  webDir: 'dist',
  // Nothing here may depend on the network: the app must work with no radio at all.
  server: { androidScheme: 'https' },
  ios: {
    // The operator is looking at a camera LCD, not at the phone. Never dim or sleep
    // mid-show — and the timecode readout is unreadable in a light theme outdoors.
    contentInset: 'always',
  },
  plugins: {},
};

export default config;
