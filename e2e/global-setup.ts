import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';

// Pre-seed the cookie-consent choice so the consent banner doesn't overlap
// bottom-of-page actions during tests (a returning visitor wouldn't see it).
// The dedicated legal-consent spec overrides storageState to get a clean slate.
export default async function globalSetup() {
  const origin = process.env.BASE_URL || 'http://localhost:3000';
  const state = {
    cookies: [],
    origins: [
      {
        origin,
        localStorage: [
          { name: 'cookie_consent', value: JSON.stringify({ necessary: true, analytics: false, marketing: false, ts: '2026-01-01T00:00:00.000Z' }) },
        ],
      },
    ],
  };
  const dir = path.join(process.cwd(), 'e2e', '.state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'consent.json'), JSON.stringify(state));
}
