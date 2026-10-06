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
