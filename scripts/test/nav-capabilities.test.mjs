// Unit tests for the vertical nav filter (#2351, epic #2348).
//
// visibleNavLinks decides what a tenant's sidebar and command palette show. Two
// ways it could go wrong both pass a glance:
//   • filtering INTERNSHIP (which carries every capability) must be a strict
//     no-op — a single link dropped there is a live feature vanishing from the
//     only product that exists today;
//   • an untagged link must ALWAYS survive, whatever the vertical — the tags are
//     an allow-list of the modules that CAN be hidden, not a deny-list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_NAV_LINKS,
  MENTOR_NAV_LINKS,
  PORTAL_NAV_LINKS,
  visibleNavLinks,
} from '../../src/lib/navLinks.ts';
import { verticalCapabilities } from '../../src/lib/verticals.ts';

const INTERNSHIP = verticalCapabilities('INTERNSHIP');
const MARKETING = verticalCapabilities('MARKETING');

test('INTERNSHIP hides nothing — the filter is a no-op for today’s product', () => {
  for (const links of [ADMIN_NAV_LINKS, MENTOR_NAV_LINKS, PORTAL_NAV_LINKS]) {
    const out = visibleNavLinks(links, INTERNSHIP);
    assert.equal(out.length, links.length);
    assert.deepEqual(out.map((l) => l.href), links.map((l) => l.href));
  }
});

test('every untagged link survives every vertical', () => {
  const untagged = ADMIN_NAV_LINKS.filter((l) => !l.capability).map((l) => l.href);
  const shown = new Set(visibleNavLinks(ADMIN_NAV_LINKS, MARKETING).map((l) => l.href));
  for (const href of untagged) assert.ok(shown.has(href), `${href} is untagged and must always show`);
});

test('MARKETING drops the mentorship/placement/sourcing admin links, keeps the rest', () => {
  const shown = new Set(visibleNavLinks(ADMIN_NAV_LINKS, MARKETING).map((l) => l.href));
  // Gone: the modules MARKETING does not carry.
  for (const href of [
    '/admin/mentors', '/admin/mentorship', '/admin/mentor-applications',
    '/admin/mentee-activity', '/admin/offers', '/admin/requisitions',
    '/admin/interview-requests', '/interviews', '/admin/sources',
  ]) {
    assert.ok(!shown.has(href), `${href} should be hidden for MARKETING`);
  }
  // Kept: the CRM core MARKETING does carry.
  for (const href of ['/admin', '/admin/board', '/admin/companies', '/admin/settings', '/admin/organizations']) {
    assert.ok(shown.has(href), `${href} should stay for MARKETING`);
  }
});

test('a tagged link needs its exact capability, not merely some capability', () => {
  // A vertical carrying only "pipeline" keeps pipeline/untagged links and drops
  // every capability-tagged one whose module it lacks.
  const onlyPipeline = ['pipeline'];
  const shown = visibleNavLinks(ADMIN_NAV_LINKS, onlyPipeline);
  assert.ok(shown.every((l) => !l.capability || l.capability === 'pipeline'));
  assert.ok(!shown.some((l) => l.capability === 'mentorship'));
});

test('filter is pure — it returns a new array and mutates neither input', () => {
  const before = ADMIN_NAV_LINKS.length;
  const out = visibleNavLinks(ADMIN_NAV_LINKS, MARKETING);
  assert.notEqual(out, ADMIN_NAV_LINKS);
  assert.equal(ADMIN_NAV_LINKS.length, before);
});
