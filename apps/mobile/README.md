# Internship CRM / Marketing CRM — native app

Expo (React Native) app for iOS and Android. It is one app that can serve every product of a deployment. Epic: #2775. Decision and reasoning: [`docs/mobile-strategy.md`](../../docs/mobile-strategy.md).

## How it fits the web app

- **One product, one host.** The internship product is built in. A build can add further products, such as a deployment's marketing product, through the build-time JSON `EXPO_PUBLIC_EXTRA_PRODUCTS` (format in `src/lib/products.ts`). With more than one product, the person picks one on first launch; with one, the app goes straight to its sign-in. From then on, every request goes to that product's host. The host decides which account signs in ([`docs/worlds.md`](../../docs/worlds.md)), so the app never mixes hosts.
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
  - a notification tap — in-app list or system push — asks the same rule before it opens a web page.
- **The keyboard.** The app draws edge to edge, so Android no longer resizes the window for the keyboard, and React Native's own `KeyboardAvoidingView` does nothing there. Screens with a text field use `react-native-keyboard-controller` (`KeyboardProvider` in the root layout): the thread follows the keyboard's height with a spacer, and sign-in uses that library's `KeyboardAvoidingView`.

## Push notifications

New messages arrive as native notifications, also while the app is closed, and a tap opens the native thread in the product they belong to. Design, the Firebase/EAS steps and what iOS still needs: [`docs/mobile-push.md`](../../docs/mobile-push.md).

- `src/lib/push.ts` holds the rules (tested); `src/lib/pushDevice.ts` the expo-notifications glue; `src/components/PushBridge.tsx` wires both into the root layout.
- The app registers its Expo token on each product it is signed in to (`POST /api/push/native`) and removes it **before** signing out of that product. Switching product keeps both.
- FCM needs `google-services.json`: locally at `apps/mobile/google-services.json` (git-ignored), on EAS through the file env var `GOOGLE_SERVICES_JSON`. Without it the app builds and runs, without push. The file is bound to the Android package, so a local build with it needs `APP_ANDROID_PACKAGE` set to that package (see [Publisher ids](#publisher-ids)). Use a Google Play system image on the emulator — FCM needs Play services.
- A dev build logs its token (`[push] Expo token …`) for a quick test from <https://expo.dev/notifications>.

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

- `APP_ENV=preview` points every product at its preview host (`preview.interncrm.com`, and each extra product's `preview` host); leave it out for production. Give it to **both** commands: `run:android` bakes it into the native config, and Metro serves it to JS. The same goes for `EXPO_PUBLIC_EXTRA_PRODUCTS`, and for the publisher ids below when you want the app under its real package.
- Save a file → Fast Refresh in about a second. `r` in the Metro terminal reloads, `m` opens the dev menu (or `Cmd+M` / `Ctrl+M` in the emulator).
- Rebuild (`run:android`) after `npx expo install` of a package with native code, or after an `app.config.ts` change. `npx expo prebuild --clean` first if the native folders get into a bad state.
- iOS on a Mac: `APP_ENV=preview npx expo run:ios` (CocoaPods runs on its own).

## Building

| EAS profile | Hosts | Output |
|---|---|---|
| `preview` | production | Internal APK / ad-hoc iOS build, for testers |
| `staging` | preview (`preview.interncrm.com` and each extra product's preview host) | Internal APK / ad-hoc iOS build |
| `production` | production | Store builds (AAB / IPA) |

One-time setup (maintainer):

1. Create an Expo account, preferably an organisation account for the publishing company.
2. Done (#2775): the project is `interncrm` under the operator's Expo organisation. `app.config.ts` is dynamic, so `eas init` cannot write to it — `extra.eas.projectId` was added by hand, and the owner comes from `EXPO_OWNER`. To re-link, run `npx eas-cli@latest init --id <projectId>` and update the project id.
3. Add `EXPO_TOKEN` (expo.dev → Access tokens) as a GitHub secret.
4. Set the [publisher ids](#publisher-ids) in both places.
5. Run Actions → *Mobile app* → `profile` / `platform`.

iOS distribution (TestFlight) needs an Apple Developer Program membership in the publishing company's name (99 USD/year, D-U-N-S). EAS creates and stores the signing certificates.

### Publisher ids

Who publishes the app is configuration, not code (#2926), because every instance of this AGPL project publishes under its own name. `app.config.ts` reads:

| Variable | What | Without it |
|---|---|---|
| `EXPO_OWNER` | The Expo account that owns the EAS project | left out of the config |
| `APP_BUNDLE_ID` | iOS `bundleIdentifier` | `com.example.crm` |
| `APP_ANDROID_PACKAGE` | Android `package` | `com.example.crm` |
| `EXPO_PUBLIC_EXTRA_PRODUCTS` | Products beyond the internship one (`src/lib/products.ts`) | the internship product only |

- **Locally** they may stay unset. The placeholders build and run a development app that installs next to a real one.
- **For an EAS build** set them as **EAS environment variables** (expo.dev → project → Environment variables) for every environment your build profiles use. The build server evaluates `app.config.ts` again with its own environment, and it bundles the JS there, so a value set only on GitHub never reaches the app. `app.config.ts` refuses an EAS build (`EAS_BUILD`) without the first three.
- **For the Mobile workflow** add `EXPO_OWNER`, `APP_BUNDLE_ID` and `APP_ANDROID_PACKAGE` as GitHub secrets as well. `eas build` reads the config on the runner first and checks the owner against the project id.
- The maintainer's values are kept in their private repository, not here.

**Permanent before the first store upload:** the bundle identifier and the Android package. Also confirm the display name.
