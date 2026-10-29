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
// A marketing-only link is absent from INTERNSHIP on purpose (verticals.ts, MARKETING_ONLY_CAPABILITIES).
const internshipLink = (l) => !l.withoutCapability && !MARKETING_ONLY_CAPABILITIES.includes(l.capability);

test('internship: every role gets its full web sidebar', () => {
  // Less the links that exist only where a module is absent (the sales
  // vertical's outbox, #2960) — INTERNSHIP carries every module.
  assert.deepEqual(
    hrefs(appNavLinks('ADMIN', INTERNSHIP)),
    hrefs(ADMIN_NAV_LINKS.filter((l) => internshipLink(l) && !l.superAdminOnly && !l.operatorOnly)),
  );
  // The operator destinations (#1607) for the default organization's ADMIN too.
  assert.deepEqual(
    hrefs(appNavLinks('ADMIN', INTERNSHIP, { operator: true })),
    hrefs(ADMIN_NAV_LINKS.filter((l) => internshipLink(l) && !l.superAdminOnly)),
  );
  // The deployment-wide destinations (#1575) only for a super admin.
  assert.deepEqual(
    hrefs(appNavLinks('ADMIN', INTERNSHIP, { superAdmin: true })),
    hrefs(ADMIN_NAV_LINKS.filter(internshipLink)),
  );
  assert.ok(!hrefs(appNavLinks('ADMIN', INTERNSHIP)).includes('/admin/api-explorer'));
  assert.deepEqual(hrefs(appNavLinks('MENTOR', INTERNSHIP)), hrefs(MENTOR_NAV_LINKS));
  assert.deepEqual(hrefs(appNavLinks('MENTEE', INTERNSHIP)), hrefs(PORTAL_NAV_LINKS));
});

test('an affiliate partner gets the partner menu only — never the portal (#3115)', () => {
  assert.deepEqual(hrefs(appNavLinks('AFFILIATE', MARKETING)), [
    '/affiliate',
    '/affiliate/customers',
    '/affiliate/commissions',
    '/affiliate/payouts',
    '/affiliate/payout-details',
    '/affiliate/contract',
  ]);
  // The internship product carries no affiliate module: nothing at all.
  assert.deepEqual(hrefs(appNavLinks('AFFILIATE', INTERNSHIP)), []);
});

test('marketing: a mentor gets the sales sidebar, and nothing mentorship-only survives', () => {
  assert.deepEqual(hrefs(appNavLinks('MENTOR', MARKETING)), hrefs(SALES_NAV_LINKS.filter((l) => !l.capability || MARKETING.includes(l.capability))));
  for (const role of ['ADMIN', 'MENTOR', 'MENTEE']) {
    for (const l of appNavLinks(role, MARKETING)) assert.ok(!l.capability || MARKETING.includes(l.capability), `${role}: ${l.href}`);
  }
});
