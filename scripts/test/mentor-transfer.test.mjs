// Unit tests for the rule behind "change this mentee's mentor" (#2289) —
// src/lib/relationHistory.ts and the reason vocabulary in
// src/lib/relationLifecycle.ts.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// What is worth pinning here is not the transaction (that needs a database)
// but the two decisions that change what the operation DOES:
//
//   1. Which of the two outcomes applies — a pairing with no history has its
//      mentor corrected in place, a pairing with history is handed over and
//      keeps its record. Getting this wrong either destroys a real mentorship's
//      attribution or litters the list with closed relations for mistakes.
//   2. The count keys the predicate reads have to be the same ones the Prisma
//      query selects. They live in two places (a plain array here, a typed
//      `_count` literal in mentorTransfer.ts) because Prisma's select cannot be
//      computed — so the last test reads the route source and compares them. A
//      renamed relation on one side would otherwise read as "no history", and
//      a real mentorship would be silently repointed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RELATION_HISTORY_COUNTS, hasRelationHistory } from '../../src/lib/relationHistory.ts';
import {
  ADMIN_END_REASON_CODES,
  END_REASON_CODES,
  isAdminEndReasonCode,
  isEndReasonCode,
  ENDED_REASSIGNED,
  ENDED_REMATCHED,
  RELATION_LIFECYCLE_STATES,
  REASON_NOTE_REQUIRED_FOR,
  endedByMentorChange,
} from '../../src/lib/relationLifecycle.ts';

test('a pairing with nothing recorded under it has no history', () => {
  assert.equal(hasRelationHistory({}), false);
  const allZero = Object.fromEntries(RELATION_HISTORY_COUNTS.map((k) => [k, 0]));
  assert.equal(hasRelationHistory(allZero), false);
});

test('a single row in ANY tracked collection is history', () => {
  for (const key of RELATION_HISTORY_COUNTS) {
    const counts = Object.fromEntries(RELATION_HISTORY_COUNTS.map((k) => [k, 0]));
    counts[key] = 1;
    assert.equal(hasRelationHistory(counts), true, `${key} should count as history`);
  }
});

test('an unknown extra count key does not make an empty pairing look used', () => {
  // The reminder rows the system writes on its own must never be the reason a
  // mis-assignment cannot be corrected — `weeklyReportReminders` is left out of
  // the list precisely so a cron run does not decide this.
  assert.equal(hasRelationHistory({ weeklyReportReminders: 3 }), false);
});

test('the admin reason list is a superset of the shared one, not a rival', () => {
  for (const code of END_REASON_CODES) {
    assert.ok(isAdminEndReasonCode(code), `${code} must stay valid for an admin`);
  }
  // …and the admin-only codes must NOT leak into the mentee's re-match form.
  assert.equal(isEndReasonCode('wrong_assignment'), false);
  assert.equal(isEndReasonCode('mentee_request'), false);
  assert.ok(isAdminEndReasonCode('wrong_assignment'));
  assert.ok(isAdminEndReasonCode('mentee_request'));
  assert.equal(isAdminEndReasonCode('something_invented'), false);
  // The note requirement is expressed as one exported constant, so the route
  // and the dialog cannot disagree about which reason needs prose.
  assert.ok(ADMIN_END_REASON_CODES.includes(REASON_NOTE_REQUIRED_FOR));
});

test('both mentor-change end states are known, and neither reads as a completion', () => {
  assert.ok(RELATION_LIFECYCLE_STATES.includes(ENDED_REASSIGNED));
  assert.ok(RELATION_LIFECYCLE_STATES.includes(ENDED_REMATCHED));
  assert.equal(endedByMentorChange({ lifecycleState: ENDED_REASSIGNED }), true);
  assert.equal(endedByMentorChange({ lifecycleState: ENDED_REMATCHED }), true);
  // A relation that really finished, and one still running, are not this.
  assert.equal(endedByMentorChange({ lifecycleState: null }), false);
  assert.equal(endedByMentorChange({}), false);
});

test('the predicate list and the Prisma _count select name the same collections', () => {
  const source = readFileSync(new URL('../../src/lib/mentorTransfer.ts', import.meta.url), 'utf8');
  const block = source.match(/_count:\s*\{\s*select:\s*\{([^}]*)\}/);
  assert.ok(block, 'mentorTransfer.ts should select relation counts');
  const selected = [...block[1].matchAll(/(\w+):\s*true/g)].map((m) => m[1]);
  assert.deepEqual([...selected].sort(), [...RELATION_HISTORY_COUNTS].sort());
});
