/// <reference types="node" />
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExpoConfig } from 'expo/config';

// One app for both products (#2775): the person picks Internship CRM or SaleVali
// at sign-in and the app then talks only to that product's host (docs/worlds.md).
//
// APP_ENV=preview points both products at their preview hosts (EAS "preview"
// profile); anything else is production.
//
// PERMANENT once published: `ios.bundleIdentifier` and `android.package` — the
// stores never let either be renamed. Confirm both before the first upload.
const env = process.env.APP_ENV === 'preview' ? 'preview' : 'production';

// Firebase config for FCM (native push, #2775, docs/mobile-push.md). Never in
// git: EAS cloud builds get it from the file env var GOOGLE_SERVICES_JSON (a
// path EAS writes the uploaded file to); a local build reads the git-ignored
// apps/mobile/google-services.json. Neither present → a build without FCM,
// which still runs, just without push.
const localGoogleServices = resolve(__dirname, 'google-services.json');
const googleServicesFile =
  process.env.GOOGLE_SERVICES_JSON ?? (existsSync(localGoogleServices) ? './google-services.json' : undefined);

const config: ExpoConfig = {
  name: 'Internship CRM',
  slug: 'interncrm',
  owner: 'bcsit-gmbh',
  scheme: 'interncrm',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: 'de.bcsitgmbh.crm',
    supportsTablet: true,
  },
  android: {
    package: 'de.bcsitgmbh.crm',
    adaptiveIcon: {
      backgroundColor: '#1D4ED8',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    ...(googleServicesFile ? { googleServicesFile } : {}),
  },
  plugins: [
    'expo-router',
    'expo-localization',
    [
      'expo-notifications',
      {
        // Status-bar glyph: Android draws it white-on-transparent, so it is the
        // monochrome layer of the launcher icon.
        icon: './assets/android-icon-monochrome.png',
        color: '#1D4ED8',
        // Must match ANDROID_CHANNEL in src/lib/expoPushRules.ts (server).
        defaultChannel: 'messages',
      },
    ],
  ],
  experiments: { typedRoutes: true },
  extra: {
    appEnv: env,
    eas: { projectId: '9a2ef811-d3ef-4135-9b3e-51695a4d9c0f' },
  },
};

export default config;
