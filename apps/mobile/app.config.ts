/// <reference types="node" />
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExpoConfig } from 'expo/config';

// One app for every product a build serves (#2775): the internship product,
// plus any the build adds through EXPO_PUBLIC_EXTRA_PRODUCTS
// (src/lib/products.ts). The person picks one at sign-in and the app then talks
// only to that product's host (docs/worlds.md).
//
// APP_ENV=preview points every product at its preview host (EAS "staging"
// profile); anything else is production.
//
// WHO PUBLISHES THE APP comes from the environment, never from this file
// (#2926): the Expo account (EXPO_OWNER) and the store ids (APP_BUNDLE_ID for
// iOS, APP_ANDROID_PACKAGE for Android) name the publisher, and this project is
// AGPL — another instance publishes under its own. For an EAS build they are
// EAS environment variables (the build server evaluates this file again, with
// its own environment); the Mobile workflow also passes them from GitHub
// secrets for the evaluation on the runner. Locally they may stay unset: the
// placeholders below build and run a development app.
//
// PERMANENT once published: the bundle identifier and the Android package — the
// stores never let either be renamed. Confirm both before the first upload.
const env = process.env.APP_ENV === 'preview' ? 'preview' : 'production';

const PLACEHOLDER_ID = 'com.example.crm';
const owner = process.env.EXPO_OWNER?.trim() || undefined;
const bundleIdentifier = process.env.APP_BUNDLE_ID?.trim() || PLACEHOLDER_ID;
const androidPackage = process.env.APP_ANDROID_PACKAGE?.trim() || PLACEHOLDER_ID;

// An EAS build server sets EAS_BUILD. A store or tester build under the
// placeholder ids would be a different, permanent app, so it fails here
// instead of after the upload.
if (process.env.EAS_BUILD && (!owner || bundleIdentifier === PLACEHOLDER_ID || androidPackage === PLACEHOLDER_ID)) {
  throw new Error(
    'EXPO_OWNER, APP_BUNDLE_ID and APP_ANDROID_PACKAGE must be set as EAS environment variables for this build (apps/mobile/README.md § Building).',
  );
}

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
  ...(owner ? { owner } : {}),
  scheme: 'interncrm',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier,
    supportsTablet: true,
  },
  android: {
    package: androidPackage,
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
