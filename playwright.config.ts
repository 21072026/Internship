import { defineConfig, devices } from '@playwright/test';

/**
 * E2E config.
 *
 * - Local default: starts the dev server and tests http://localhost:3000.
 *   Run headed to watch: `npm run test:e2e -- --headed`.
 * - CI: builds + `next start`, runs headless against localhost.
 * - Against a deployed env: set BASE_URL (e.g. BASE_URL=https://preview.interncrm.com),
 *   which skips the local webServer and tests the remote URL.
 */
const externalBase = process.env.BASE_URL;
const PORT = 3000;
const localURL = `http://localhost:${PORT}`;

// ── The `isolation` project (#1566) ──────────────────────────────────────────
// A SECOND app server, on its own port, booted with MT_ENFORCE_ISOLATION=true.
//
// WHY A SECOND SERVER. Playwright's `webServer` is a config-level option, not a
// per-project one, so "a project whose server has the flag on" can only mean
// "an extra server the project points its baseURL at". The alternative — a
// single server with the flag on — is not available to us: roughly 150 specs
// assume the single-tenant behaviour the flag switches off, and the flag itself
// is still un-flipped in production (docs/tenant-isolation.md). The default
// project therefore keeps the flag OFF and its results are unchanged.
//
// The project (and its server) is only assembled when the run actually asks for
// it, so `npm run test:e2e` and the CI smoke gate never pay for a second
// `next start`. Everything under e2e/isolation/ belongs to it and is excluded
// from the default project below — a spec there would otherwise run twice, once
// against a server that does not enforce anything.
export const ISOLATION_PORT = 3010;
export const ISOLATION_URL = `http://localhost:${ISOLATION_PORT}`;

// `--project=isolation` and `--project isolation` are both spellings Playwright
// accepts, and E2E_ISOLATION=1 covers a caller who selects it some other way
// (`--grep`, an IDE runner) and still needs the server.
function projectRequested(name: string): boolean {
  return process.argv.some(
    (arg, i) => arg === `--project=${name}` || (arg === '--project' && process.argv[i + 1] === name)
  );
}
const runsIsolation = process.env.E2E_ISOLATION === '1' || projectRequested('isolation');
// The default server is skipped only when the command line selects the
// isolation project and nothing else. E2E_ISOLATION=1 on its own adds the
// isolation server without taking the default one away, because a run that has
// not filtered by project still executes the chromium specs.
const runsDefault = !projectRequested('isolation') || projectRequested('chromium');

if (runsIsolation && externalBase) {
  // Fail loudly rather than silently testing the wrong thing: the whole point
  // of this project is a server WE started with the flag on, and a deployed
  // environment's flag is whatever it is (today: off, everywhere).
  throw new Error(
    'The `isolation` Playwright project boots its own server with MT_ENFORCE_ISOLATION=true ' +
      'and cannot run against a deployed BASE_URL. Unset BASE_URL and try again.'
  );
}
// Shared with e2e/health.spec.ts, which asserts both sides of the token gate.
export const E2E_HEALTH_TOKEN = 'e2e-health-token';
// Shared with e2e/inbound-email.spec.ts. CI serves a production build, and
// since #870 the inbound webhook's fail-open is dev-only — so without this the
// endpoint answers 401 to everything. Setting it also makes the spec exercise
// the shape production actually runs (secret required AND supplied) instead of
// the lenient path.
export const E2E_INBOUND_SECRET = 'e2e-inbound-secret';
// Shared with e2e/job-queue-health.spec.ts (#1674): the operator address the
// dead-letter alert mails when the queue is not empty.
export const E2E_ALERT_EMAIL_TO = 'ops-alert@e2e.local';
// Shared with e2e/meeting-end.spec.ts. Unset, /api/webhooks/jaas answers 404
// to everything and the live-room assertions would be vacuous.
export const E2E_JAAS_WEBHOOK_SECRET = 'e2e-jaas-webhook-secret';
// Shared with e2e/google-calendar.spec.ts (#709). The Google OAuth token
// exchange and the Calendar write cannot be driven against real Google without
// a Cloud project and a human at a consent screen — which is why that slice sat
// unfinished. Pointing the app's Google endpoints at a local stub that speaks
// the same wire format makes the app's own half of the flow testable: state
// signing, token sealing, refresh, event create/patch/delete, revoke.
export const E2E_GOOGLE_MOCK_PORT = 4599;
const googleMock = `http://127.0.0.1:${E2E_GOOGLE_MOCK_PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: externalBase || localURL,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    // The app registers /sw.js on every role shell; requests served through a
    // service worker bypass page.route(), silently disabling API mocks (the
    // document-requirements pagination mock was the first casualty). No spec
    // needs a live SW (pwa.spec fetches /sw.js as a static asset), so block it.
    serviceWorkers: 'block',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    // Returning-visitor state: consent already given so the banner stays hidden
    // and never overlaps page actions. legal-consent.spec overrides this.
    storageState: './e2e/.state/consent.json',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      // e2e/isolation/** belongs to the `isolation` project below; those specs
      // assert cross-tenant behaviour that only holds with the flag on.
      testIgnore: '**/isolation/**',
    },
    ...(runsIsolation
      ? [
        {
          name: 'isolation',
          testMatch: '**/isolation/**/*.spec.ts',
          use: { ...devices['Desktop Chrome'], baseURL: ISOLATION_URL },
        },
      ]
      : []),
  ],
  // Only spin up the app locally; when BASE_URL targets a deployed env, skip it.
  // `runsDefault` / `runsIsolation` keep each run to the servers it needs: an
  // ordinary run never boots the isolation server, and `--project=isolation`
  // never boots the default one.
  webServer: externalBase
    ? undefined
    : [
      ...(runsDefault ? [
      {
        command: `node e2e/support/google-mock.mjs`,
        url: `${googleMock}/__state`,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
        env: { GOOGLE_MOCK_PORT: String(E2E_GOOGLE_MOCK_PORT) },
      },
      {
        command: process.env.CI ? 'npm run start' : 'npm run dev',
        url: localURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        // Playwright talks to Next directly — there is no nginx appending to
        // X-Forwarded-For here, so 0 is the honest setting and it is what makes
        // the spoofing assertions in rate-limit-spoof.spec.ts meaningful (#858).
        env: {
          TRUSTED_PROXY_COUNT: '0',
          // E2E must never deliver real mail from a developer's loaded .env;
          // synchronous route mail would otherwise wait on that external SMTP.
          SMTP_USER: '',
          SMTP_BULK_USER: '',
          // Exercises the gated shape of /api/health (#897). Unset, the endpoint
          // keeps its legacy fully-public response and health.spec.ts's
          // assertions about what an anonymous caller may see would be vacuous.
          HEALTH_TOKEN: E2E_HEALTH_TOKEN,
          // Operator alert address (#1674). Pinned to a synthetic one rather
          // than left to whatever the environment inherits: the dead-letter
          // alert's "silent when green, one mail when not" contract is only
          // testable when an address exists, and a real one must never be the
          // address a test run picks up. SMTP_USER is blank above, so the send
          // still stops at a SKIPPED EmailLog row.
          ALERT_EMAIL_TO: E2E_ALERT_EMAIL_TO,
          INBOUND_SECRET: E2E_INBOUND_SECRET,
          // Shared with e2e/error-boundary.spec.ts (#1602). Unlocks the two
          // test-only routes that throw on purpose so the route-level error
          // boundaries can be exercised; a NODE_ENV check would not work here
          // because CI serves a production build. Unset everywhere else, so the
          // routes are a 404 on preview and production.
          E2E_ERROR_ROUTES: '1',
          JAAS_WEBHOOK_SECRET: E2E_JAAS_WEBHOOK_SECRET,
          // Google Calendar (#709): credentials that only mean anything to the
          // local stub above, plus the master switch the integration is gated
          // on. Production ships with GOOGLE_CALENDAR_ENABLED unset.
          GOOGLE_CLIENT_ID: 'e2e-google-client',
          GOOGLE_CLIENT_SECRET: 'e2e-google-secret',
          GOOGLE_CALENDAR_ENABLED: '1',
          GOOGLE_OAUTH_TOKEN_URL: `${googleMock}/token`,
          GOOGLE_OAUTH_REVOKE_URL: `${googleMock}/revoke`,
          GOOGLE_CALENDAR_API_BASE: `${googleMock}/calendar/v3`,
        },
      },
      ] : []),
      ...(runsIsolation ? [
      {
        // The same app, on its own port, with tenant isolation ENFORCED (#1566).
        // Deliberately lean: none of the stubs the default server wires up
        // (Google Calendar, the inbound-mail secret, the throwing error routes)
        // are involved in a cross-tenant read, and every one of them is another
        // way for this server to differ from the default one for a reason that
        // has nothing to do with the flag.
        command: process.env.CI ? 'npm run start' : 'npm run dev',
        url: ISOLATION_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
          MT_ENFORCE_ISOLATION: 'true',
          PORT: String(ISOLATION_PORT),
          // NextAuth builds its callback URLs from this; left at the default
          // server's origin, the post-sign-in redirect walks off this server
          // and the spec signs in to the wrong one.
          NEXTAUTH_URL: ISOLATION_URL,
          TRUSTED_PROXY_COUNT: '0',
          SMTP_USER: '',
          SMTP_BULK_USER: '',
        },
      },
      ] : []),
    ],
});
