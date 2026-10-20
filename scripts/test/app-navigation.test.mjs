// The native app's menu is the web sidebar (#2775): same source, same filter,
// same shell choice as the layouts. Pinned so the two cannot drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// appNavigation.ts imports through the `@/` alias; see ts-extensionless-resolve.mjs.
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { appNavLinks } = await import('../../src/lib/appNavigation.ts');
const { ADMIN_NAV_LINKS, MENTOR_NAV_LINKS, PORTAL_NAV_LINKS, SALES_NAV_LINKS } = await import('../../src/lib/navLinks.ts');
const { verticalCapabilities, MARKETING_ONLY_CAPABILITIES } = await import('../../src/lib/verticals.ts');

const INTERNSHIP = verticalCapabilities('INTERNSHIP');
const MARKETING = verticalCapabilities('MARKETING');
const hrefs = (l) => l.map((x) => x.href);

test('internship: every role gets its full web sidebar', () => {
  // Less the links that exist only where a module is absent (the sales
  // vertical's outbox, #2960) — INTERNSHIP carries every module.
  // A marketing-only link is absent here on purpose (verticals.ts, MARKETING_ONLY_CAPABILITIES).
  assert.deepEqual(
    hrefs(appNavLinks('ADMIN', INTERNSHIP)),
    hrefs(ADMIN_NAV_LINKS.filter((l) => !l.withoutCapability && !MARKETING_ONLY_CAPABILITIES.includes(l.capability))),
  );
  assert.deepEqual(hrefs(appNavLinks('MENTOR', INTERNSHIP)), hrefs(MENTOR_NAV_LINKS));
  assert.deepEqual(hrefs(appNavLinks('MENTEE', INTERNSHIP)), hrefs(PORTAL_NAV_LINKS));
});

test('marketing: a mentor gets the sales sidebar, and nothing mentorship-only survives', () => {
  assert.deepEqual(hrefs(appNavLinks('MENTOR', MARKETING)), hrefs(SALES_NAV_LINKS.filter((l) => !l.capability || MARKETING.includes(l.capability))));
  for (const role of ['ADMIN', 'MENTOR', 'MENTEE']) {
    for (const l of appNavLinks(role, MARKETING)) assert.ok(!l.capability || MARKETING.includes(l.capability), `${role}: ${l.href}`);
  }
});
