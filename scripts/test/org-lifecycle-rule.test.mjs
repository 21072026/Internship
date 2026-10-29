// Unit tests for the tenant lifecycle rule (src/lib/orgLifecycleRule.ts, #1580/#1582).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { planRename, archiveDecision, isArchived, DEFAULT_ORG_SLUG } = await import('../../src/lib/orgLifecycleRule.ts');

const org = (over = {}) => ({ id: 'o1', name: 'Acme Sales', slug: 'acme-sales', ssoEnabled: false, archivedAt: null, ...over });

test('a rename writes only what changed, the slug normalised', () => {
  const plan = planRename(org(), { name: '  Acme Talent ', slug: 'Acme Talent!' });
  assert.deepEqual(plan, { ok: true, data: { name: 'Acme Talent', slug: 'acme-talent' }, slugChanged: true, forcedSso: false });
  const nameOnly = planRename(org(), { name: 'Acme Two', slug: 'acme-sales' });
  assert.deepEqual(nameOnly, { ok: true, data: { name: 'Acme Two' }, slugChanged: false, forcedSso: false });
});

test('an unchanged request is refused rather than written', () => {
  assert.deepEqual(planRename(org(), { name: 'Acme Sales', slug: 'acme-sales' }), { ok: false, code: 'nothing_to_change' });
  assert.deepEqual(planRename(org(), {}), { ok: false, code: 'nothing_to_change' });
});

test('empty name and an empty slug are refused', () => {
  assert.equal(planRename(org(), { name: '   ' }).code, 'name_invalid');
  assert.equal(planRename(org(), { name: 'x'.repeat(121) }).code, 'name_invalid');
  assert.equal(planRename(org(), { slug: '!!!' }).code, 'slug_invalid');
});

test('the default organization keeps its slug but may be renamed', () => {
  const d = org({ slug: DEFAULT_ORG_SLUG });
  assert.equal(planRename(d, { slug: 'other' }).code, 'default_org_slug');
  assert.equal(planRename(d, { name: 'Operator' }).ok, true);
});

test('an SSO tenant changes its slug only when forced, and says it was forced', () => {
  const s = org({ ssoEnabled: true });
  assert.equal(planRename(s, { slug: 'new-slug' }).code, 'sso_slug_locked');
  const forced = planRename(s, { slug: 'new-slug', force: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.forcedSso, true);
  // A name-only change needs no force.
  assert.equal(planRename(s, { name: 'Renamed' }).forcedSso, false);
});

test('an archived tenant is not renamed', () => {
  assert.equal(planRename(org({ archivedAt: new Date() }), { name: 'X' }).code, 'archived');
});

test('archive: never the default org, never the actor’s own, never twice', () => {
  assert.deepEqual(archiveDecision(org(), true, 'operator-org'), { ok: true });
  assert.equal(archiveDecision(org({ slug: DEFAULT_ORG_SLUG }), true, 'x').code, 'default_org');
  assert.equal(archiveDecision(org(), true, 'o1').code, 'own_org');
  assert.equal(archiveDecision(org({ archivedAt: new Date() }), true, 'x').code, 'already_archived');
});

test('unarchive: only what is archived', () => {
  assert.equal(archiveDecision(org(), false, 'x').code, 'not_archived');
  assert.deepEqual(archiveDecision(org({ archivedAt: '2026-10-29T00:00:00Z' }), false, 'o1'), { ok: true });
});

test('isArchived reads the column', () => {
  assert.equal(isArchived(null), false);
  assert.equal(isArchived(org()), false);
  assert.equal(isArchived(org({ archivedAt: new Date() })), true);
});
