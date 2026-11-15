// personHref (#1166, #2348) — where "open profile" goes, per viewer role, per
// person role and per vertical. Pure; no Next, no DB.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { personHref } = await import('../../src/lib/personHref.ts');

const ROLES = ['ADMIN', 'MENTOR', 'MENTEE', 'COMPANY', 'SOURCE'];
const INTERNSHIP = { mentorship: true };
const MARKETING = { mentorship: false };
const person = (role, relationId = 'rel1') => ({ id: 'p1', role, relationId });

// The whole table: viewer × person × vertical → expected target.
const EXPECTED = {
  INTERNSHIP: {
    ADMIN: { ADMIN: null, MENTOR: '/admin/mentors/p1', MENTEE: '/admin/candidates/p1', COMPANY: null, SOURCE: null },
    MENTOR: { ADMIN: null, MENTOR: null, MENTEE: '/mentor/mentees/rel1', COMPANY: null, SOURCE: null },
  },
  MARKETING: {
    // No mentor pages: /admin/mentors is closed by the vertical gate and there
    // is no /admin/users/<id>, so a rep's name links nowhere — never a 404.
    ADMIN: { ADMIN: null, MENTOR: null, MENTEE: '/admin/candidates/p1', COMPANY: null, SOURCE: null },
    MENTOR: { ADMIN: null, MENTOR: null, MENTEE: null, COMPANY: null, SOURCE: null },
  },
};

for (const [vertical, caps] of [['INTERNSHIP', INTERNSHIP], ['MARKETING', MARKETING]]) {
  for (const viewer of ROLES) {
    test(`${vertical}: a ${viewer} viewer`, () => {
      for (const target of ROLES) {
        const want = EXPECTED[vertical][viewer]?.[target] ?? null;
        assert.equal(personHref(viewer, person(target), caps), want, `${viewer} → ${target}`);
      }
    });
  }
}

test('no capabilities argument = the base product (every existing caller unchanged)', () => {
  assert.equal(personHref('ADMIN', person('MENTOR')), '/admin/mentors/p1');
  assert.equal(personHref('MENTOR', person('MENTEE')), '/mentor/mentees/rel1');
});

test('a person with no role reads as a MENTEE; a mentor without the relation gets no link', () => {
  assert.equal(personHref('ADMIN', { id: 'p1' }, MARKETING), '/admin/candidates/p1');
  assert.equal(personHref('MENTOR', person('MENTEE', null), INTERNSHIP), null);
  assert.equal(personHref(null, person('MENTEE'), INTERNSHIP), null);
});
