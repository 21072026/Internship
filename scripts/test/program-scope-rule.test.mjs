// Unit tests for src/lib/programScopeRule.ts (#1577) — what a PROGRAM_ADMIN's
// grants reach, as the `where` fragments every narrowed list ANDs in.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { grantRelationTerms, programRelationWhere, programMenteeWhere, programPeopleWhere, NOBODY, adminReceives, ORG_LEVEL_ADMIN_WHERE } = await import(
  '../../src/lib/programScopeRule.ts'
);

const cohortA = { cohortId: 'c-a', companyId: null };
const company1 = { cohortId: null, companyId: 'co-1' };
const both = { cohortId: 'c-b', companyId: 'co-2' };
const empty = { cohortId: null, companyId: null };

test('zero grants, or grants naming nothing, reach nobody — never {}', () => {
  for (const grants of [[], [empty]]) {
    assert.deepEqual(programRelationWhere(grants), NOBODY);
    assert.deepEqual(programMenteeWhere(grants), NOBODY);
    assert.deepEqual(programPeopleWhere(grants), NOBODY);
  }
});

test('one relation term per grant; a grant naming both narrows to both', () => {
  assert.deepEqual(grantRelationTerms([cohortA, company1, both, empty]), [
    { cohortId: 'c-a' },
    { companyId: 'co-1' },
    { cohortId: 'c-b', companyId: 'co-2' },
  ]);
});

test('candidates: the mentee side of a relation inside the grants', () => {
  assert.deepEqual(programMenteeWhere([cohortA]), { menteeRelations: { some: { OR: [{ cohortId: 'c-a' }] } } });
});

test('people: either side of a relation, plus a company-only grant\'s own accounts', () => {
  assert.deepEqual(programPeopleWhere([cohortA, company1]), {
    OR: [
      { menteeRelations: { some: { OR: [{ cohortId: 'c-a' }, { companyId: 'co-1' }] } } },
      { mentorRelations: { some: { OR: [{ cohortId: 'c-a' }, { companyId: 'co-1' }] } } },
      { role: 'COMPANY', companyId: { in: ['co-1'] } },
    ],
  });
  // A cohort+company grant does not hand over the company's whole account list.
  assert.equal(JSON.stringify(programPeopleWhere([both])).includes('"role":"COMPANY"'), false);
});

// ── Who hears about it (#3485) ──────────────────────────────────────────────

test('ORG_ADMIN and OBSERVER hear about everything, the org-level notices included', () => {
  for (const tier of ['ORG_ADMIN', 'OBSERVER']) {
    assert.equal(adminReceives(tier, [], null), true);
    assert.equal(adminReceives(tier, [], { cohortId: 'c-z' }), true);
  }
});

test('a PROGRAM_ADMIN hears only about a subject one of its grants covers — never an org-level notice', () => {
  assert.equal(adminReceives('PROGRAM_ADMIN', [cohortA], null), false);
  assert.equal(adminReceives('PROGRAM_ADMIN', [cohortA], {}), false);
  assert.equal(adminReceives('PROGRAM_ADMIN', [cohortA], { cohortId: 'c-a' }), true);
  assert.equal(adminReceives('PROGRAM_ADMIN', [cohortA], { cohortId: 'c-b' }), false);
  assert.equal(adminReceives('PROGRAM_ADMIN', [company1], { companyId: 'co-1' }), true);
  // A grant naming both needs both.
  assert.equal(adminReceives('PROGRAM_ADMIN', [both], { cohortId: 'c-b' }), false);
  assert.equal(adminReceives('PROGRAM_ADMIN', [both], { cohortId: 'c-b', companyId: 'co-2' }), true);
  assert.equal(adminReceives('PROGRAM_ADMIN', [], { cohortId: 'c-a' }), false);
});

test('an unknown tier hears nothing', () => {
  assert.equal(adminReceives(null, [cohortA], { cohortId: 'c-a' }), false);
});

test('the org-level recipient filter: an empty column or ORG_ADMIN/OBSERVER — never PROGRAM_ADMIN', () => {
  assert.deepEqual(ORG_LEVEL_ADMIN_WHERE, { OR: [{ adminLevel: null }, { adminLevel: { in: ['ORG_ADMIN', 'OBSERVER'] } }] });
});
