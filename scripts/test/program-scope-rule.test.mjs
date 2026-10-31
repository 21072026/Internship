// Unit tests for src/lib/programScopeRule.ts (#1577) — what a PROGRAM_ADMIN's
// grants reach, as the `where` fragments every narrowed list ANDs in.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { grantRelationTerms, programRelationWhere, programMenteeWhere, programPeopleWhere, NOBODY } = await import(
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
