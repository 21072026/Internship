// Unit tests for the route → capability page gate (src/lib/navRouteCapability.ts,
// src/lib/pageCapabilityGate.ts).
//
// Run: npm run test:unit
//
// Hiding a nav link is presentation; the URL has to answer 404 as well. The
// rule is derived from the nav catalogue, and each gated segment carries a
// one-line layout.tsx that calls gatePage('<href>') — so the ratchet at the end
// fails the moment a link is tagged without its segment being closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { capabilityForPath, pathAllowed, pathIsUnder } from '../../src/lib/navRouteCapability.ts';
import { ADMIN_NAV_LINKS, MENTOR_NAV_LINKS, PORTAL_NAV_LINKS } from '../../src/lib/navLinks.ts';
import { verticalCapabilities } from '../../src/lib/verticals.ts';

const LINKS = [
  { href: '/admin', capability: undefined },
  { href: '/admin/newsletters', capability: 'mentorship' },
  { href: '/admin/email', capability: 'mentorship' },
  { href: '/admin/companies', capability: undefined },
];

test('segment-wise prefix matching', () => {
  assert.equal(pathIsUnder('/admin/email', '/admin/email'), true);
  assert.equal(pathIsUnder('/admin/email/', '/admin/email'), true);
  assert.equal(pathIsUnder('/admin/email/x', '/admin/email'), true);
  assert.equal(pathIsUnder('/admin/emails', '/admin/email'), false);
  assert.equal(pathIsUnder('/admin/email-log', '/admin/email'), false);
});

test('longest match wins; an uncovered path needs nothing', () => {
  assert.equal(capabilityForPath(LINKS, '/admin/newsletters'), 'mentorship');
  assert.equal(capabilityForPath(LINKS, '/admin/newsletters/abc'), 'mentorship');
  assert.equal(capabilityForPath(LINKS, '/admin/companies/1'), null);
  assert.equal(capabilityForPath(LINKS, '/admin'), null);
  assert.equal(capabilityForPath(LINKS, '/admin/whatever'), null);
  assert.equal(capabilityForPath(LINKS, '/elsewhere'), null);
});

test('MARKETING is refused the internship-only surfaces; INTERNSHIP keeps all', () => {
  const all = [...ADMIN_NAV_LINKS, ...MENTOR_NAV_LINKS, ...PORTAL_NAV_LINKS];
  const M = verticalCapabilities('MARKETING');
  const I = verticalCapabilities('INTERNSHIP');
  for (const p of ['/admin/newsletters', '/admin/email', '/admin/testimonials', '/admin/re-engagement', '/newsletters', '/admin/goal-templates']) {
    assert.equal(pathAllowed(all, p, M), false, p);
    assert.equal(pathAllowed(all, p, I), true, p);
  }
  for (const p of ['/admin', '/admin/companies', '/admin/organizations', '/admin/settings', '/admin/documents']) {
    assert.equal(pathAllowed(all, p, M), true, p);
  }
});

test('ratchet: every capability-tagged destination closes its URL', () => {
  const tagged = [...ADMIN_NAV_LINKS, ...MENTOR_NAV_LINKS, ...PORTAL_NAV_LINKS].filter((l) => l.capability);
  const missing = [];
  const seen = new Set();
  for (const { href } of tagged) {
    if (seen.has(href)) continue;
    seen.add(href);
    // Segments outside the gated shells close by other means: /interviews and
    // /mentor/* and /portal/* sit behind shell-level vertical gates (#2351).
    if (!href.startsWith('/admin/') && href !== '/newsletters') continue;
    const file = new URL(`../../src/app${href}/layout.tsx`, import.meta.url);
    if (!existsSync(file) || !readFileSync(file, 'utf8').includes(`gatePage('${href}')`)) missing.push(href);
  }
  assert.deepEqual(missing, [], `tagged nav links without a gated segment layout: ${missing.join(', ')}`);
});
