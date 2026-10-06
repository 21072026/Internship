# Internship CRM / SaleVali — native app

Expo (React Native) app for iOS and Android. It is one app that serves both products. Epic: #2775. Decision and reasoning: [`docs/mobile-strategy.md`](../../docs/mobile-strategy.md).

## How it fits the web app

- **One product, one host.** The person picks Internship CRM or SaleVali on first launch. From then on, every request goes to that product's host (`src/lib/products.ts`). The host decides which account signs in ([`docs/worlds.md`](../../docs/worlds.md)), so the app never mixes hosts.
- **No session of its own.** Sign-in runs NextAuth's own HTTP flow (`src/lib/authClient.ts`):
  - `GET /api/auth/csrf`, then `POST /api/auth/callback/credentials`.
  - Every session is still minted by the one `jwt` callback in `src/lib/auth.ts`. Rate limits, lockouts, 2FA and recovery codes, enforced SSO and the world check all apply unchanged.
  - The OS cookie jar holds the session, exactly as a browser would.
  - Native `fetch` sends no `Origin` header. The cross-site write gate (`src/lib/writeOrigin.ts`) treats such a request as a non-browser client.
- **"Keep me signed in"** works the same way as on the web:
  - after sign-in: `POST /api/auth/remember`;
  - on launch: `/api/auth/remember/refresh`, then `callback/remember` (the `/auth/resume` flow);
  - sign-out: `DELETE /api/auth/remember` first, then `/api/auth/signout`. This is the same order as `signOutEverywhere()`.
- **Hybrid.** `src/components/WebScreen.tsx` shows any page of the product's web app, already signed in:
  - It uses the same cookie jar: on Android always; on iOS through `sharedCookiesEnabled`.
  - It never leaves the product's origin. Any other URL opens in the system browser.
  - If the page lands on `/auth/signin`, the session is gone and the native sign-in takes over.
  - It is used for every surface that is not native yet, and for the admin, pipeline and analytics screens, which stay on the web on purpose.
- **A way into messages opens the native screen.** `/messages/c/<id>` opens the native thread; `/messages` and `/notifications` open their tabs (`src/lib/nativeRoutes.ts`, the one rule). This holds however a page gets there:
  - a link tap is stopped before the site's router sees it;
  - a `router.push()` after a fetch (the "send message" buttons) and a redirect's `replaceState` (the legacy `/messages/<relationId>` URL) are let through, reported and undone with `history.back()`;
  - a full load is refused in `onShouldStartLoadWithRequest`;
  - a notification tap asks the same rule before it opens a web page.
- **The keyboard.** The app draws edge to edge, so Android no longer resizes the window for the keyboard, and React Native's own `KeyboardAvoidingView` does nothing there. Screens with a text field use `react-native-keyboard-controller` (`KeyboardProvider` in the root layout): the thread follows the keyboard's height with a spacer, and sign-in uses that library's `KeyboardAvoidingView`.

## The site inside the app

- **The site knows it is in the app.** The web view adds `InternCRMApp/1` to its User-Agent. The root layout then renders `<html data-embedded-app>` (`src/lib/embeddedApp.ts`).
- **The site's own chrome steps aside.** Anything marked `data-app-chrome` is hidden by `src/app/globals.css`: the mobile top bar and drawer (`ResponsiveShell`), the messages header (`MessagesShell`) and the install prompt.
  - **When you add web chrome that duplicates something the app draws natively, mark it the same way.**
- **The page reports its title and colours** (`src/lib/webMeta.ts`, `useWebHeader`). The native header shows the page's own title, without the ` · <product>` suffix, on the page's own background. A dark page never sits under a white bar, whatever theme the person picked on the site.
- **The menu is native.** The More tab lists the person's web sidebar from `GET /api/app/navigation`, which is built from the same `navLinks.ts`, capability filter and labels as the web (`src/lib/appNavigation.ts`). Every nav key needs an Ionicons glyph in `src/lib/menu.ts`; a unit test reads `navLinks.ts` and fails on a missing one.
- **Native screens follow the phone's light/dark setting.** The palettes in `src/lib/theme.ts` use the web's Tailwind grays.

## Develop

```bash
cd apps/mobile
npm install
npm run typecheck
npm test               # node --test on src/lib/*.test.ts
npx expo start         # Expo Go / dev build on a phone
```

Always add dependencies with `npx expo install <pkg>`, so the versions match the Expo SDK. Do not use plain `npm install` for this. `react-dom` is pinned to the exact `react` version, because npm otherwise resolves Expo's optional peer to a newer React and refuses the install.

The `android/` and `ios/` folders are generated (`npx expo prebuild`) and git-ignored. Configure native behaviour in `app.config.ts`.

## Emulator

Expo Go is not enough: the app uses native modules that Expo Go does not ship (`react-native-keyboard-controller`, …). Run a **development build** (`expo-dev-client`) instead. Build it once; after that Metro delivers JS changes in seconds with Fast Refresh. Rebuild only when a native dependency or `app.config.ts` changes.

### One-time setup

| | macOS | Windows | Linux |
|---|---|---|---|
| JDK 17 | `brew install --cask zulu@17` (sudo) | `winget install Azul.Zulu.17.JDK` | Zulu 17 / `openjdk-17-jdk` |
| Android Studio | `brew install --cask android-studio` | `winget install Google.AndroidStudio` | tarball or `snap install android-studio --classic` |
| `ANDROID_HOME` | `~/Library/Android/sdk` | `%LOCALAPPDATA%\Android\Sdk` | `~/Android/Sdk` |
| Acceleration | Hypervisor.Framework (built in) | WHPX: *Windows Hypervisor Platform* feature | KVM: user in the `kvm` group |
| System image (ABI) | Apple Silicon `arm64-v8a`, Intel `x86_64` | `x86_64` | `x86_64` |

- SDK components (Android Studio → SDK Manager, or `sdkmanager`): `platform-tools`, `emulator`, `cmdline-tools;latest`, `platforms;android-36`, `build-tools;36.0.0`, `ndk;27.1.12297006`, plus a `google_apis_playstore` system image. The versions come from `react-native/gradle/libs.versions.toml` (RN 0.86: compileSdk/targetSdk 36); check there after an SDK upgrade.
- Put `$ANDROID_HOME/emulator` and `$ANDROID_HOME/platform-tools` first on `PATH`. A stray older `adb` (e.g. Homebrew's `android-platform-tools`) behind it fights the SDK's adb server.
- Without Android Studio's first-run wizard: unzip the [command-line tools](https://developer.android.com/studio#command-tools) to `$ANDROID_HOME/cmdline-tools/latest`, then `sdkmanager --licenses` and `sdkmanager <components>`. They need a JDK; Android Studio's bundled one works (`/Applications/Android Studio.app/Contents/jbr/Contents/Home` on macOS).
- Create the AVD: Device Manager → Pixel 8 → Google Play image; or `avdmanager create avd -n Pixel_8_API_36 -d pixel_8 -k "system-images;android-36;google_apis_playstore;x86_64"`. `emulator -accel-check` should report acceleration.
- macOS, for iOS: Xcode (App Store, your job), then `brew install watchman cocoapods`.
- Intel Mac on a new macOS is a Homebrew *Tier 3* setup: no bottles, so `watchman` (and its `cmake`, …) compiles from source for an hour or more. Start it early, and not alongside the first Gradle build. Metro runs without Watchman.

### The loop

```bash
emulator -avd Pixel_8_API_36 &                 # or start it from Android Studio
cd apps/mobile
APP_ENV=preview npx expo run:android           # first time, and after any native change (10–30 min cold)
APP_ENV=preview npx expo start --dev-client    # every other day: Metro only, press `a`
```

- `APP_ENV=preview` points both products at the preview hosts (`preview.interncrm.com`, `marketing.bcsit-gmbh.dev`); leave it out for production. Give it to **both** commands: `run:android` bakes it into the native config, and Metro serves it to JS.
- Save a file → Fast Refresh in about a second. `r` in the Metro terminal reloads, `m` opens the dev menu (or `Cmd+M` / `Ctrl+M` in the emulator).
- Rebuild (`run:android`) after `npx expo install` of a package with native code, or after an `app.config.ts` change. `npx expo prebuild --clean` first if the native folders get into a bad state.
- iOS on a Mac: `APP_ENV=preview npx expo run:ios` (CocoaPods runs on its own).

## Building

| EAS profile | Hosts | Output |
|---|---|---|
| `preview` | production | Internal APK / ad-hoc iOS build, for testers |
| `staging` | preview (`preview.interncrm.com`, `marketing.bcsit-gmbh.dev`) | Internal APK / ad-hoc iOS build |
| `production` | production | Store builds (AAB / IPA) |

One-time setup (maintainer):

1. Create an Expo account, preferably an organisation account for bcsit GmbH.
2. Done (#2775): the project is `@bcsit-gmbh/interncrm` (org account). `app.config.ts` is dynamic, so `eas init` cannot write to it — `owner` and `extra.eas.projectId` were added by hand. To re-link, run `npx eas-cli@latest init --id <projectId>` and update both fields.
3. Add `EXPO_TOKEN` (expo.dev → Access tokens) as a GitHub secret.
4. Run Actions → *Mobile app* → `profile` / `platform`.

iOS distribution (TestFlight) needs an Apple Developer Program membership in bcsit GmbH's name (99 USD/year, D-U-N-S). EAS creates and stores the signing certificates.

**Permanent before the first store upload:** `ios.bundleIdentifier` and `android.package` in `app.config.ts`. Both are currently `de.bcsitgmbh.crm`. Also confirm the display name.
