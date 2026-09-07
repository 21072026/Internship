// Unit tests for the ONE reader of "one mentee, at most one ACTIVE mentor"
// (#419) — src/lib/activeMentorship.ts.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// These assert the WHERE the helper builds, not the database. The bug they pin
// down is the one this module exists to make impossible: the invitation
// auto-link asked the same question with NO `status` filter, so a CLOSED pair
// looked live and an existing mentee's live mentor looked absent. The `orderBy`
// matters just as much — violating rows exist in the wild today, and an
// unordered findFirst would name a different offender between two calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findActiveMentorship,
  hasOtherActiveMentorship,
  ALREADY_MENTORED_ERROR,
} from '../../src/lib/activeMentorship.ts';

/** Records the args of the single findFirst the helper is allowed to issue. */
function fakeDb(result = null) {
  const calls = [];
  return {
    calls,
    mentorshipRelation: {
      findFirst: (args) => {
        calls.push(args);
        return Promise.resolve(result);
      },
    },
  };
}

test('the query always filters on ACTIVE and the given mentee', async () => {
  const db = fakeDb();
  await findActiveMentorship(db, 'mentee-1');

  assert.equal(db.calls.length, 1);
  assert.deepEqual(db.calls[0].where, { menteeId: 'mentee-1', status: 'ACTIVE' });
});

test('no exceptRelationId means no id filter at all', async () => {
  const db = fakeDb();
  await findActiveMentorship(db, 'mentee-1');

  assert.ok(!('id' in db.calls[0].where));
});

test('exceptRelationId becomes id: { not }, for the reopen path', async () => {
  const db = fakeDb();
  await findActiveMentorship(db, 'mentee-1', { exceptRelationId: 'rel-9' });

  assert.deepEqual(db.calls[0].where, {
    menteeId: 'mentee-1',
    status: 'ACTIVE',
    id: { not: 'rel-9' },
  });
});

test('the result is ordered, so two violating rows answer identically twice', async () => {
  const db = fakeDb();
  await findActiveMentorship(db, 'mentee-1');

  assert.deepEqual(db.calls[0].orderBy, { startDate: 'asc' });
});

test('no orgId is added — the tenant middleware owns that scoping', async () => {
  const db = fakeDb();
  await findActiveMentorship(db, 'mentee-1');

  assert.ok(!('orgId' in db.calls[0].where));
});

test('hasOtherActiveMentorship is false when nothing matches, true when a row does', async () => {
  assert.equal(await hasOtherActiveMentorship(fakeDb(null), 'mentee-1'), false);
  assert.equal(
    await hasOtherActiveMentorship(fakeDb({ id: 'r1', mentorId: 'm1', startDate: new Date() }), 'mentee-1'),
    true,
  );
});

test('the refusal body keeps the exact sentence the smoke test matches on', () => {
  // e2e/dup-guard-transliteration.spec.ts asserts /active mentorship/i on the
  // 409 from POST /api/mentorship. Tidying this string reds the PR gate.
  assert.match(ALREADY_MENTORED_ERROR.error, /active mentorship/i);
  assert.equal(ALREADY_MENTORED_ERROR.code, 'already_mentored');
});
