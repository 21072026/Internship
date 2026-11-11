// Unit tests for the dormant-first-contact rule (#1499/#1508/#1516,
// docs/dormant-first-contacts.md): which relations parked at first contact are
// "dormant", and the sweep that is the single writer of `dormantSince`.
//
// The module talks to Prisma, so the test seats the in-memory fake from
// ./fake-prisma.mjs before importing it (#1598) — the rule is exercised, and
// measured by the coverage floor, without a database.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { installFakePrisma } from './fake-prisma.mjs';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const db = installFakePrisma();
const { findDormantFirstContacts, sweepDormantFirstContacts, DORMANT_GRACE_DAYS } = await import(
  '../../src/lib/dormantFirstContact.ts'
);

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);
const FIRST = 'APPLICATION_100'; // the default pipeline's start stage (no org stages configured)

const rel = (id, extra = {}) => ({
  id,
  orgId: null,
  menteeId: `mentee-${id}`,
  pipelineStatus: FIRST,
  stageDeadline: null,
  ...extra,
});
const mentorMessage = (relationId, at) => ({ relationId, senderId: 'mentor', createdAt: at });
const menteeMessage = (relationId, at) => ({ relationId, senderId: `mentee-${relationId}`, createdAt: at });

beforeEach(() => db.reset());

test('nothing to look at → no queries at all', async () => {
  assert.deepEqual([...(await findDormantFirstContacts([]))], []);
  assert.equal(db.calls.length, 0);
});

test('one unanswered outreach older than the grace window is dormant', async () => {
  db.handlers['message.findMany'] = () => [mentorMessage('a', daysAgo(DORMANT_GRACE_DAYS + 1))];
  assert.deepEqual([...(await findDormantFirstContacts([rel('a')]))], ['a']);
});

test('inside the grace window is not dormant yet', async () => {
  db.handlers['message.findMany'] = () => [mentorMessage('a', daysAgo(DORMANT_GRACE_DAYS - 1))];
  assert.equal((await findDormantFirstContacts([rel('a')])).size, 0);
});

test('no outreach at all is never dormant — the first message is what the mentor owes', async () => {
  assert.equal((await findDormantFirstContacts([rel('a')])).size, 0);
});

test('a logged interaction counts as outreach, same as a message (#1512)', async () => {
  db.handlers['interactionLog.findMany'] = () => [{ relationId: 'a', date: daysAgo(30) }];
  assert.deepEqual([...(await findDormantFirstContacts([rel('a')]))], ['a']);
});

test('the silence is measured from the FIRST unanswered outreach, not the last "Hi?" (#1516)', async () => {
  db.handlers['message.findMany'] = () => [mentorMessage('a', daysAgo(30)), mentorMessage('a', daysAgo(1))];
  assert.deepEqual([...(await findDormantFirstContacts([rel('a')]))], ['a']);
});

test('a mentee reply after the outreach keeps the relation live', async () => {
  db.handlers['message.findMany'] = () => [mentorMessage('a', daysAgo(30)), menteeMessage('a', daysAgo(20))];
  assert.equal((await findDormantFirstContacts([rel('a')])).size, 0);
});

test('outreach after the last reply restarts the clock from that outreach', async () => {
  db.handlers['message.findMany'] = () => [
    mentorMessage('a', daysAgo(60)),
    menteeMessage('a', daysAgo(50)),
    mentorMessage('a', daysAgo(40)),
  ];
  assert.deepEqual([...(await findDormantFirstContacts([rel('a')]))], ['a']);
});

test("the mentee's own group-chat post is a sign of life", async () => {
  db.handlers['message.findMany'] = () => [mentorMessage('a', daysAgo(30))];
  db.handlers['message.groupBy'] = () => [{ senderId: 'mentee-a', _max: { createdAt: daysAgo(5) } }];
  assert.equal((await findDormantFirstContacts([rel('a')])).size, 0);
});

test('an open question or a pending meeting request keeps it off the list', async () => {
  db.handlers['message.findMany'] = () => [mentorMessage('a', daysAgo(30)), mentorMessage('b', daysAgo(30))];
  db.handlers['mentorQuestion.findMany'] = () => [{ relationId: 'a' }];
  db.handlers['meetingRequest.findMany'] = () => [{ relationId: 'b' }];
  assert.equal((await findDormantFirstContacts([rel('a'), rel('b')])).size, 0);
});

test('a stage deadline or a later stage is never a first-contact candidate — and costs no lookup', async () => {
  const set = await findDormantFirstContacts([
    rel('a', { stageDeadline: daysAgo(-3) }),
    rel('b', { pipelineStatus: 'INTERVIEW_PENDING_250' }),
  ]);
  assert.equal(set.size, 0);
  assert.equal(db.calls.filter((c) => c.model === 'message').length, 0);
});

test('the sweep flags the newly dormant and clears the ones that came back, counters included', async () => {
  db.handlers['mentorshipRelation.findMany'] = () => [
    { ...rel('new'), dormantSince: null },
    { ...rel('still'), dormantSince: daysAgo(10) },
    { ...rel('back'), dormantSince: daysAgo(10) },
  ];
  db.handlers['message.findMany'] = () => [
    mentorMessage('new', daysAgo(20)),
    mentorMessage('still', daysAgo(40)),
    mentorMessage('back', daysAgo(40)),
    menteeMessage('back', daysAgo(2)),
  ];
  const result = await sweepDormantFirstContacts();
  assert.deepEqual(result, { checked: 3, flagged: 1, cleared: 1 });
  const writes = db.calls.filter((c) => c.model === 'mentorshipRelation' && c.op === 'updateMany');
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].args.where, { id: { in: ['new'] } });
  assert.ok(writes[0].args.data.dormantSince instanceof Date);
  assert.deepEqual(writes[1].args.where, { id: { in: ['back'] } });
  assert.deepEqual(writes[1].args.data, { dormantSince: null, dormantNudgeCount: 0, dormantNudgeSentAt: null });
});

test('a sweep with nothing to change writes nothing', async () => {
  db.handlers['mentorshipRelation.findMany'] = () => [{ ...rel('quiet'), dormantSince: null }];
  assert.deepEqual(await sweepDormantFirstContacts(), { checked: 1, flagged: 0, cleared: 0 });
  assert.equal(db.calls.filter((c) => c.op === 'updateMany').length, 0);
});
