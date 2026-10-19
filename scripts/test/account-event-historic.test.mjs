// Unit tests for historic mode of the account-event feed: which events replay
// the past, how a historic write is dated, and where a historic trial lands
// (src/lib/accountEventRule.ts; contract in docs/integrations/account-events.md
// § Historic mode).
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const {
  HISTORIC_EVENT_AGE_DAYS,
  HISTORY_STEP_MS,
  backdateFor,
  historicMoveAt,
  historicTrialLanding,
  isHistoricEvent,
  shouldUndoHistoricExpiry,
} = await import(
  '../../src/lib/accountEventRule.ts'
);
const { DECISION_WINDOW_CLAIM, DEFAULT_DECISION_WINDOW_DAYS } = await import('../../src/lib/trialReminderRule.ts');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-19T10:00:00Z');
const ago = (days) => new Date(NOW.getTime() - days * DAY);

test('the threshold is three days, a named constant', () => {
  assert.equal(HISTORIC_EVENT_AGE_DAYS, 3);
});

test('an event is historic when the sender says replay, or when it is older than the threshold', () => {
  assert.equal(isHistoricEvent(NOW, NOW, false), false, 'a live event');
  assert.equal(isHistoricEvent(ago(1), NOW, undefined), false, 'a day late is still live');
  assert.equal(isHistoricEvent(ago(HISTORIC_EVENT_AGE_DAYS), NOW, null), false, 'exactly at the threshold is live');
  assert.equal(isHistoricEvent(new Date(ago(HISTORIC_EVENT_AGE_DAYS).getTime() - 1), NOW, false), true, 'just past it is historic');
  assert.equal(isHistoricEvent(ago(800), NOW, false), true, 'years old');
  assert.equal(isHistoricEvent(NOW, NOW, true), true, 'replay: true makes even a fresh event historic');
  assert.equal(isHistoricEvent(new Date(NOW.getTime() + DAY), NOW, false), false, 'a clock-skewed future event is live');
});

test('a historic write is dated at the event, never in the future; a live one is not dated by us', () => {
  assert.equal(backdateFor(false, ago(400), NOW), undefined);
  assert.equal(backdateFor(true, ago(400), NOW)?.toISOString(), ago(400).toISOString());
  assert.equal(backdateFor(true, new Date(NOW.getTime() + DAY), NOW)?.toISOString(), NOW.toISOString());
});

test('a trial that ran out lands at TRIAL_EXPIRED, dated at its end, and its closed window is claimed', () => {
  const landing = historicTrialLanding({
    pipelineStatus: 'TRIAL_ACTIVE',
    trialEndsAt: ago(370),
    enteredAt: ago(400),
    now: NOW,
    decisionWindowDays: DEFAULT_DECISION_WINDOW_DAYS,
  });
  assert.deepEqual(landing, { expire: true, expiredAt: ago(370), preclaimDecisionWindow: true });
  assert.ok(DECISION_WINDOW_CLAIM < 0, 'the claim is the negative threshold the sweep reads');
});

test('the expiry is dated strictly after the record entered the trial', () => {
  const landing = historicTrialLanding({
    pipelineStatus: 'TRIAL_ACTIVE',
    trialEndsAt: ago(60),
    enteredAt: ago(50),
    now: NOW,
    decisionWindowDays: 30,
  });
  assert.equal(landing.expire, true);
  assert.equal(landing.expiredAt?.getTime(), ago(50).getTime() + HISTORY_STEP_MS, 'an end before the start');
  // An end exactly at the start must not tie with the move into the trial.
  const tie = historicTrialLanding({ pipelineStatus: 'TRIAL_ACTIVE', trialEndsAt: ago(50), enteredAt: ago(50), now: NOW, decisionWindowDays: 30 });
  assert.ok(tie.expiredAt && tie.expiredAt.getTime() > ago(50).getTime());
});

test('a historic move is never dated at or before the record\'s newest history, nor before its start', () => {
  const at = ago(700);
  assert.equal(historicMoveAt(at, { startDate: null, newestHistoryAt: null }).toISOString(), at.toISOString());
  assert.equal(historicMoveAt(at, { startDate: ago(800), newestHistoryAt: ago(750) }).toISOString(), at.toISOString(), 'older history: the event');
  assert.equal(historicMoveAt(at, { startDate: ago(650), newestHistoryAt: null }).toISOString(), ago(650).toISOString(), 'not before the start');
  // A person moved the record today: the replayed move lands right after it.
  const manual = new Date(NOW.getTime() - 60_000);
  assert.equal(historicMoveAt(at, { startDate: ago(800), newestHistoryAt: manual }).getTime(), manual.getTime() + HISTORY_STEP_MS);
  assert.equal(historicMoveAt(at, { startDate: null, newestHistoryAt: at }).getTime(), at.getTime() + HISTORY_STEP_MS, 'never a tie');
});

test('a move from before the replay\'s own expiry takes that expiry back; nothing else is touched', () => {
  const expiry = { fromStatus: 'TRIAL_ACTIVE', toStatus: 'TRIAL_EXPIRED', changedById: null, createdAt: ago(370) };
  const base = { pipelineStatus: 'TRIAL_EXPIRED', toStage: 'DEAL_WON', at: ago(390), newest: expiry };
  assert.equal(shouldUndoHistoricExpiry(base), true, 'paid during the trial: the expiry never happened');
  assert.equal(shouldUndoHistoricExpiry({ ...base, at: ago(350) }), false, 'paid after the expiry: it stays');
  assert.equal(shouldUndoHistoricExpiry({ ...base, at: ago(370) }), false, 'at the very moment: it stays');
  assert.equal(shouldUndoHistoricExpiry({ ...base, newest: { ...expiry, changedById: 'user-1' } }), false, 'a person\'s move');
  assert.equal(shouldUndoHistoricExpiry({ ...base, newest: { ...expiry, fromStatus: 'LEAD_QUALIFIED' } }), false, 'not the system expiry');
  assert.equal(shouldUndoHistoricExpiry({ ...base, newest: null }), false, 'no history');
  assert.equal(shouldUndoHistoricExpiry({ ...base, pipelineStatus: 'TRIAL_ACTIVE' }), false, 'not expired');
  assert.equal(shouldUndoHistoricExpiry({ ...base, toStage: 'TRIAL_ACTIVE' }), false, 'a second trial start is not a move past the expiry');
});

test('the same calendar-day rule as the daily expiry: the last day is still the customer\'s', () => {
  const endsToday = new Date('2026-10-19T00:30:00Z');
  const today = historicTrialLanding({ pipelineStatus: 'TRIAL_ACTIVE', trialEndsAt: endsToday, enteredAt: ago(30), now: NOW, decisionWindowDays: 30 });
  assert.deepEqual(today, { expire: false, expiredAt: null, preclaimDecisionWindow: false });
  const yesterday = historicTrialLanding({
    pipelineStatus: 'TRIAL_ACTIVE',
    trialEndsAt: new Date('2026-10-18T23:59:00Z'),
    enteredAt: ago(30),
    now: NOW,
    decisionWindowDays: 30,
  });
  assert.equal(yesterday.expire, true);
});

test('a window still open is NOT claimed: its one bell is real, future work', () => {
  const recent = historicTrialLanding({ pipelineStatus: 'TRIAL_ACTIVE', trialEndsAt: ago(10), enteredAt: ago(40), now: NOW, decisionWindowDays: 30 });
  assert.equal(recent.expire, true);
  assert.equal(recent.preclaimDecisionWindow, false);
  // …and a shorter org window that has already shut is claimed.
  const shortWindow = historicTrialLanding({ pipelineStatus: 'TRIAL_ACTIVE', trialEndsAt: ago(10), enteredAt: ago(40), now: NOW, decisionWindowDays: 7 });
  assert.equal(shortWindow.preclaimDecisionWindow, true);
});

test('a running trial stays; a record already expired only gets its claim; no trial end means nothing', () => {
  const running = historicTrialLanding({
    pipelineStatus: 'TRIAL_ACTIVE',
    trialEndsAt: new Date(NOW.getTime() + 5 * DAY),
    enteredAt: ago(25),
    now: NOW,
    decisionWindowDays: 30,
  });
  assert.deepEqual(running, { expire: false, expiredAt: null, preclaimDecisionWindow: false });
  const alreadyExpired = historicTrialLanding({ pipelineStatus: 'TRIAL_EXPIRED', trialEndsAt: ago(200), enteredAt: ago(230), now: NOW, decisionWindowDays: 30 });
  assert.deepEqual(alreadyExpired, { expire: false, expiredAt: null, preclaimDecisionWindow: true });
  const won = historicTrialLanding({ pipelineStatus: 'DEAL_WON', trialEndsAt: ago(200), enteredAt: ago(230), now: NOW, decisionWindowDays: 30 });
  assert.deepEqual(won, { expire: false, expiredAt: null, preclaimDecisionWindow: false });
  const noEnd = historicTrialLanding({ pipelineStatus: 'TRIAL_ACTIVE', trialEndsAt: null, enteredAt: ago(230), now: NOW, decisionWindowDays: 30 });
  assert.deepEqual(noEnd, { expire: false, expiredAt: null, preclaimDecisionWindow: false });
});

test('the envelope accepts an optional replay flag and stays schema version 1', async () => {
  const { accountEventSchema } = await import('../../src/lib/accountEventSchema.ts');
  const base = {
    event_id: 'evt-replay-1',
    schema_version: 1,
    event_type: 'trial_started',
    occurred_at: '2024-03-01T09:00:00Z',
    external_id: 'acct-1',
  };
  const without = accountEventSchema.safeParse(base);
  assert.ok(without.success);
  assert.equal(without.data.replay, undefined);
  const flagged = accountEventSchema.safeParse({ ...base, replay: true });
  assert.ok(flagged.success);
  assert.equal(flagged.data.replay, true);
  assert.ok(accountEventSchema.safeParse({ ...base, replay: null }).success);
  const bad = accountEventSchema.safeParse({ ...base, replay: 'yes' });
  assert.ok(!bad.success);
  assert.deepEqual(bad.error.issues.map((i) => i.path.join('.')), ['replay']);
});

test('the writer reaches stage effects through the shared path, and only for a live move', async () => {
  // Since #2966 a LIVE move goes through recordStageMove() (src/lib/stageMove.ts)
  // like a person's move of the card; a historic move stays silent. So the
  // writer imports the shared path and nothing that rings, mails or sets an
  // SLA by itself, and its one call to it sits on the live branch.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../src/lib/accountEventIngest.ts', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  for (const banned of [
    '@/lib/stageChangeEffects',
    '@/lib/stageSla',
    '@/lib/webhooks',
    '@/lib/notify',
    '@/lib/mailOutbox',
    '@/services/emailService',
  ]) {
    assert.ok(!imports.includes(banned), `accountEventIngest.ts must not import ${banned}`);
  }
  const code = source.replace(/\/\/.*$/gm, '');
  assert.ok(!/stageDeadline/.test(code), 'no stageDeadline write outside a comment');
  const calls = [...code.matchAll(/recordStageMove\(/g)];
  assert.equal(calls.length, 1, 'one call to the shared stage path');
  const live = code.indexOf('if (!ctx.at) {');
  assert.ok(live >= 0 && live < calls[0].index, 'the call sits on the live branch');
  assert.ok(code.indexOf('return;', live) > calls[0].index, 'inside that branch, before it returns');
  // Historic win-backs set no deadline either: winBack() is asked to be quiet.
  assert.match(code, /quiet: ctx\.historic/);
});
