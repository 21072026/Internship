// Unit tests for the grouped admin sidebar (#3752, iOS-Settings style).
//
// Grouping and hub pages move links around, and the failure that hides is a page
// nobody can reach any more: tagged into a group the sidebar never shows, or
// hidden behind a hub row whose page never lists it. These assertions pin that
// every admin destination stays reachable — in the sidebar or on its group's
// hub page — for every audience, and that the hub copy exists for every row.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_NAV_LINKS,
  NAV_GROUPS,
  groupNavLinks,
  isNavGroup,
  navHubHref,
  visibleNavLinks,
} from '../../src/lib/navLinks.ts';
import { verticalCapabilities } from '../../src/lib/verticals.ts';
import { ADMIN_TIERS, TIER_PERMISSIONS } from '../../src/lib/authzRule.ts';
import { dictionaries } from '../../src/i18n/dictionaries.ts';

const INTERNSHIP = verticalCapabilities('INTERNSHIP');
const MARKETING = verticalCapabilities('MARKETING');

const AUDIENCES = [];
for (const [vertical, caps] of [['INTERNSHIP', INTERNSHIP], ['MARKETING', MARKETING]]) {
  for (const who of [{}, { operator: true }, { superAdmin: true, operator: true }]) {
    AUDIENCES.push({ label: `${vertical} ${JSON.stringify(who)}`, caps, opts: who });
  }
  for (const tier of ADMIN_TIERS) {
    AUDIENCES.push({ label: `${vertical} ${tier}`, caps, opts: { permissions: TIER_PERMISSIONS[tier] } });
  }
}

test('every admin link is a daily item or sits in a known group; a hub link always has a group', () => {
  for (const l of ADMIN_NAV_LINKS) {
    if (l.group !== undefined) assert.ok(isNavGroup(l.group), `${l.href}: unknown group ${l.group}`);
    if (l.hub) assert.ok(l.group, `${l.href}: a hub link needs a group`);
  }
});

test('every admin destination stays reachable — in the sidebar or on its hub page — for every audience', () => {
  for (const { label, caps, opts } of AUDIENCES) {
    const visible = visibleNavLinks(ADMIN_NAV_LINKS, caps, opts);
    const { top, sections } = groupNavLinks(visible);
    const reachable = new Set([...top, ...sections.flatMap((s) => [...s.sidebar, ...s.hub])].map((l) => l.href));
    for (const l of visible) assert.ok(reachable.has(l.href), `${label}: ${l.href} is in no sidebar slot and no hub page`);
    assert.equal(reachable.size, visible.length, `${label}: a link was counted twice`);
    // No empty group header, ever.
    for (const s of sections) assert.ok(s.sidebar.length + s.hub.length > 0, `${label}: empty group ${s.group}`);
    // A group that has hub links has a hub page to list them on.
    for (const s of sections) if (s.hub.length) assert.equal(navHubHref(s.group), `/admin/hub/${s.group}`);
  }
});

test('the daily list stays short (iOS: a handful of rows above the groups)', () => {
  const { top } = groupNavLinks(visibleNavLinks(ADMIN_NAV_LINKS, INTERNSHIP, { superAdmin: true, operator: true }));
  assert.ok(top.length <= 8, `${top.length} daily items: ${top.map((l) => l.href).join(', ')}`);
});

test('MARKETING shows no Mentoring group, and no group it cannot fill', () => {
  const { sections } = groupNavLinks(visibleNavLinks(ADMIN_NAV_LINKS, MARKETING, { superAdmin: true, operator: true }));
  assert.ok(!sections.some((s) => s.group === 'mentoring'));
});

test('group labels exist in every locale', () => {
  for (const [locale, d] of Object.entries(dictionaries)) {
    for (const g of NAV_GROUPS) assert.equal(typeof d.navGroups[g], 'string', `${locale}: navGroups.${g}`);
  }
});

test('every hub row has a description, and the internship namespace holds only internship links', () => {
  const internshipOnly = (l) => l.capability === 'mentorship' || l.capability === 'projects';
  for (const [locale, d] of Object.entries(dictionaries)) {
    for (const l of ADMIN_NAV_LINKS.filter((x) => x.hub)) {
      const ns = internshipOnly(l) ? d.navHubInternship : d.navHub;
      assert.equal(typeof ns[l.key], 'string', `${locale}: no hub description for ${l.key}`);
    }
    // The LEAK_EXEMPT reason in scripts/check-i18n.ts depends on this: every
    // key of navHubInternship belongs to a mentorship/projects-tagged hub link.
    for (const key of Object.keys(d.navHubInternship)) {
      const link = ADMIN_NAV_LINKS.find((l) => l.key === key && l.hub);
      assert.ok(link && internshipOnly(link), `${locale}: navHubInternship.${key} is not an internship-only hub link`);
    }
    for (const key of Object.keys(d.navHub)) {
      const link = ADMIN_NAV_LINKS.find((l) => l.key === key && l.hub);
      assert.ok(link && !internshipOnly(link), `${locale}: navHub.${key} is not a shared hub link`);
    }
  }
});
