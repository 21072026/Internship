// Unit tests for the cross-world content-isolation rules (package D).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// Three things are pinned here, each of which typechecks perfectly while wrong:
//
//   • WHICH ORG AN AUDIT ENTRY BELONGS TO. logActivity() (src/lib/activity.ts)
//     stamps by src/lib/activityOrgRule.ts, and the deploy backfill
//     (prisma/backfill-activity-log-org.mjs) applies a plain-ESM mirror of the
//     same order to legacy rows. The two must agree on a shared corpus, or a
//     row written today and a row backfilled tonight land in different tenants.
//   • THE BACKFILLS ONLY FILL NULLS. They run on every deploy; a statement that
//     rewrote an attributed row would move entries between tenants each time.
//   • BUILT-IN CONTENT IS PER VERTICAL. The internship career documents and the
//     curated career newsletters must never be offered to a MARKETING tenant —
//     and an unknown vertical must get NOTHING, not the internship set.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const rule = await import('../../src/lib/activityOrgRule.ts');
const activityBackfill = await import('../../prisma/backfill-activity-log-org.mjs');
const templateBackfill = await import('../../prisma/backfill-task-template-org.mjs');
const { templatesFor, getTemplate, TEMPLATES_BY_VERTICAL } = await import('../../src/lib/templates.ts');
const newsletters = await import('../../src/lib/newsletterContent.ts');

const CORPUS = [
  [{}, null],
  [{ explicitOrgId: 'org-x', actorOrgId: 'org-a', targetType: 'user', targetUserOrgId: 'org-t' }, 'org-x'],
  [{ actorOrgId: 'org-a', targetType: 'user', targetUserOrgId: 'org-t' }, 'org-a'],
  [{ actorOrgId: null, targetType: 'user', targetUserOrgId: 'org-t' }, 'org-t'],
  [{ actorOrgId: null, targetType: 'User', targetUserOrgId: 'org-t' }, 'org-t'],
  // A target that is not a user never lends its "org" — the id is not a user id.
  [{ actorOrgId: null, targetType: 'company', targetUserOrgId: 'org-t' }, null],
  [{ actorOrgId: null, targetType: null, targetUserOrgId: 'org-t' }, null],
  [{ explicitOrgId: null, actorOrgId: undefined, targetType: 'user', targetUserOrgId: null }, null],
];

test('activity org rule: explicit, then actor, then target user, else null', () => {
  for (const [facts, expected] of CORPUS) {
    assert.equal(rule.pickActivityOrg(facts), expected, JSON.stringify(facts));
  }
});

test('the backfill mirror agrees with the TS rule on the whole corpus', () => {
  for (const [facts] of CORPUS) {
    assert.equal(activityBackfill.pickActivityOrg(facts), rule.pickActivityOrg(facts), JSON.stringify(facts));
  }
  assert.deepEqual([...activityBackfill.USER_TARGET_TYPES], [...rule.USER_TARGET_TYPES]);
});

test('backfill statements only ever fill NULL orgIds, actor pass first', () => {
  const a = activityBackfill.backfillStatements();
  assert.deepEqual(a.map((s) => s.label), ['from actor', 'from target user']);
  const t = templateBackfill.backfillStatements();
  assert.deepEqual(t.map((s) => s.label), ['from project', 'from author']);
  for (const { sql } of [...a, ...t]) {
    assert.match(sql, /^UPDATE /);
    assert.match(sql, /\.`orgId` IS NULL/, sql);
    assert.match(sql, /u?p?\.`orgId` IS NOT NULL/, sql);
    assert.doesNotMatch(sql, /DELETE|DROP|INSERT/i);
  }
  // A shared template is attributed to its author only when it has no project.
  assert.match(t[1].sql, /`projectId` IS NULL/);
  // The target-user pass is limited to entries that name a user.
  assert.match(a[1].sql, /`targetType` IN \('user', 'User'\)/);
});

test('task template rule: project org, then author org, else default (null)', () => {
  assert.equal(templateBackfill.pickTemplateOrg({ projectOrgId: 'p', authorOrgId: 'a' }), 'p');
  assert.equal(templateBackfill.pickTemplateOrg({ projectOrgId: null, authorOrgId: 'a' }), 'a');
  assert.equal(templateBackfill.pickTemplateOrg({ projectOrgId: null, authorOrgId: null }), null);
});

test('document built-ins: internship set for INTERNSHIP, none for MARKETING or an unknown key', () => {
  const ids = templatesFor('INTERNSHIP').map((t) => t.id);
  assert.deepEqual(ids, ['cv', 'cover-letter', 'reference-request', 'internship-report', 'interview-prep']);
  assert.equal(templatesFor('MARKETING').length, 0);
  for (const other of ['FUTURE', '', null, undefined]) assert.equal(templatesFor(other).length, 0);
  assert.equal(getTemplate('cv', 'INTERNSHIP')?.id, 'cv');
  assert.equal(getTemplate('cv', 'MARKETING'), undefined);
  // Every vertical of the catalogue has an entry, even an empty one.
  assert.deepEqual(Object.keys(TEMPLATES_BY_VERTICAL).sort(), ['INTERNSHIP', 'MARKETING']);
});

test('newsletter library: internship issues for INTERNSHIP only', () => {
  const internship = newsletters.newsletterTemplatesFor('INTERNSHIP');
  assert.ok(internship.length > 0);
  assert.equal(newsletters.newsletterTemplatesFor('MARKETING').length, 0);
  assert.equal(newsletters.newsletterTemplatesFor('FUTURE').length, 0);
  const key = internship[0].key;
  assert.equal(newsletters.newsletterTemplate(key, 'INTERNSHIP')?.key, key);
  assert.equal(newsletters.newsletterTemplate(key, 'MARKETING'), null);
  // The auto-cadence walks the vertical's own library; MARKETING is "exhausted" at once.
  assert.ok(newsletters.nextUnusedTemplate([], undefined, 'INTERNSHIP'));
  assert.equal(newsletters.nextUnusedTemplate([], undefined, 'MARKETING'), null);
  // The default stays INTERNSHIP, so the existing default-org caller is unchanged.
  assert.equal(newsletters.nextUnusedTemplate([])?.key, newsletters.nextUnusedTemplate([], undefined, 'INTERNSHIP')?.key);
});
