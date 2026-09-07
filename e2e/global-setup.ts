import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { COOKIE_CONSENT_KEY, COOKIE_CONSENT_VERSION } from '../src/lib/cookieConsent';
import { ISOLATION_URL } from '../playwright.config';

// Pre-seed the cookie-consent choice so the consent banner doesn't overlap
// bottom-of-page actions during tests (a returning visitor wouldn't see it).
// The dedicated legal-consent spec overrides storageState to get a clean slate.
// Read straight from the app so bumping COOKIE_CONSENT_VERSION doesn't silently
// put the banner back in front of every test in the suite.
export default async function globalSetup() {
  const origin = process.env.BASE_URL || 'http://localhost:3000';
  const consent = [
    { name: COOKIE_CONSENT_KEY, value: JSON.stringify({ version: COOKIE_CONSENT_VERSION, necessary: true, analytics: false, marketing: false, ts: '2026-01-01T00:00:00.000Z' }) },
  ];
  // localStorage is per-origin, and the `isolation` project (#1566) talks to a
  // second server on its own port — a different origin, which would otherwise
  // start every isolation spec with the consent banner over the form. Seeding
  // both origins costs nothing for a run that only uses one of them.
  const origins = [origin, ISOLATION_URL].filter((o, i, all) => all.indexOf(o) === i);
  const state = {
    cookies: [],
    origins: origins.map((o) => ({ origin: o, localStorage: consent })),
  };
  const dir = path.join(process.cwd(), 'e2e', '.state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'consent.json'), JSON.stringify(state));
}
