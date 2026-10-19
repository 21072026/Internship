// Unit tests for the account-event table (#2966): what every event type does
// to a funnel record at every stage — src/lib/accountEventRule.ts
// `ingestIntent` + `planAccountEvent` + `lostReasonFor`, and the batch's
// processing order (`batchOrder`). The contract is
// docs/integrations/account-events.md § Event types.
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const {
  ACCOUNT_EVENT_BATCH_MAX,
  ACCOUNT_EVENT_TYPES,
  batchOrder,
  ingestIntent,
  lostReasonFor,
  planAccountEvent,
} = await import('../../src/lib/accountEventRule.ts');
const { MARKETING_DROPOFF_REASON_CODES } = await import('../../src/lib/dropoffReasons.ts');

// The MARKETING funnel's shape (src/lib/programTemplates.ts MARKETING_FUNNEL):
// on-path stages in order, DEAL_LOST off the path.
const STAGES = [
  { key: 'LEAD_NEW', order: 0, isOffPath: false },
  { key: 'LEAD_CONTACTED', order: 1, isOffPath: false },
  { key: 'LEAD_QUALIFIED', order: 2, isOffPath: false },
  { key: 'TRIAL_ACTIVE', order: 3, isOffPath: false },
  { key: 'TRIAL_EXPIRED', order: 4, isOffPath: false },
  { key: 'DEAL_WON', order: 5, isOffPath: false },
  { key: 'DEAL_LOST', order: 6, isOffPath: true },
];
const SLUG = 'demo-feed';
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-19T12:00:00Z');
const TRIAL_ENDED = new Date(NOW.getTime() - 5 * DAY);
const OTHER = { reasonCode: 'OTHER', reasonNote: `${SLUG}: ended during trial` };
const CANCELLED = { reasonCode: 'CUSTOMER_CANCELLED', reasonNote: null };

const move = (toStage, extra = {}) => ({ kind: 'move', toStage, ...extra });
const winBack = (toStage, predecessorClosed = false) => ({ kind: 'win_back', toStage, predecessorClosed });
const refused = (toStage) => ({ kind: 'refused_backward', toStage });
const NOTHING = 'nothing';

function plan(eventType, record, { stages = STAGES, occurredAt = NOW } = {}) {
  const intent = ingestIntent(eventType);
  if (intent.kind === 'record') return 'record';
  const out = planAccountEvent({
    intent,
    record: { status: 'ACTIVE', wasWon: record.pipelineStatus === 'DEAL_WON', trialEndsAt: null, ...record },
    stages,
    occurredAt,
    sourceSlug: SLUG,
  });
  return out.kind === 'nothing' ? NOTHING : out;
}

// Every event type × every stage of an ACTIVE record. A record-only type is
// 'record' everywhere; `nothing` is answered `recorded` with a detail.
const TABLE = {
  LEAD_NEW: { open: move('TRIAL_ACTIVE'), won: move('DEAL_WON'), lost: move('DEAL_LOST', OTHER), reactivated: NOTHING },
  LEAD_CONTACTED: { open: move('TRIAL_ACTIVE'), won: move('DEAL_WON'), lost: move('DEAL_LOST', OTHER), reactivated: NOTHING },
  LEAD_QUALIFIED: { open: move('TRIAL_ACTIVE'), won: move('DEAL_WON'), lost: move('DEAL_LOST', OTHER), reactivated: NOTHING },
  // The same stage is a "move" the writer records nothing for (no history row).
  TRIAL_ACTIVE: { open: move('TRIAL_ACTIVE'), won: move('DEAL_WON'), lost: move('DEAL_LOST', OTHER), reactivated: NOTHING },
  // An event after the trial's end: a re-trial is a new journey.
  TRIAL_EXPIRED: { open: winBack('TRIAL_ACTIVE'), won: move('DEAL_WON'), lost: move('DEAL_LOST', OTHER), reactivated: NOTHING },
  DEAL_WON: { open: refused('TRIAL_ACTIVE'), won: move('DEAL_WON'), lost: move('DEAL_LOST', CANCELLED), reactivated: NOTHING },
  DEAL_LOST: { open: winBack('TRIAL_ACTIVE'), won: winBack('DEAL_WON'), lost: NOTHING, reactivated: winBack('TRIAL_ACTIVE') },
};
const COLUMN = {
  account_created: 'open',
  trial_started: 'open',
  converted: 'won',
  cancelled: 'lost',
  deactivated: 'lost',
  reactivated: 'reactivated',
};

test('the table: every event type × every stage of an active record', () => {
  for (const [stage, row] of Object.entries(TABLE)) {
    for (const type of ACCOUNT_EVENT_TYPES) {
      const expected = COLUMN[type] ? row[COLUMN[type]] : 'record';
      const trialEndsAt = stage === 'TRIAL_EXPIRED' ? TRIAL_ENDED : null;
      assert.deepEqual(plan(type, { pipelineStatus: stage, trialEndsAt }), expected, `${type} on ${stage}`);
    }
  }
});

test('a trial event from inside an expired trial\'s window belongs to that trial: refused as before', () => {
  const insideWindow = new Date(TRIAL_ENDED.getTime() - DAY);
  assert.deepEqual(
    plan('trial_started', { pipelineStatus: 'TRIAL_EXPIRED', trialEndsAt: TRIAL_ENDED }, { occurredAt: insideWindow }),
    refused('TRIAL_ACTIVE'),
  );
  // Exactly at the end is still the old trial; a moment after it is a new one.
  assert.deepEqual(
    plan('trial_started', { pipelineStatus: 'TRIAL_EXPIRED', trialEndsAt: TRIAL_ENDED }, { occurredAt: TRIAL_ENDED }),
    refused('TRIAL_ACTIVE'),
  );
  assert.deepEqual(
    plan('trial_started', { pipelineStatus: 'TRIAL_EXPIRED', trialEndsAt: TRIAL_ENDED }, { occurredAt: new Date(TRIAL_ENDED.getTime() + 1) }),
    winBack('TRIAL_ACTIVE'),
  );
  // An expired record without a known end: any new trial is a new journey.
  assert.deepEqual(plan('account_created', { pipelineStatus: 'TRIAL_EXPIRED', trialEndsAt: null }), winBack('TRIAL_ACTIVE'));
});

test('the loss reason: CUSTOMER_CANCELLED once the record had been won, otherwise OTHER with a fixed note', () => {
  assert.deepEqual(lostReasonFor(true, SLUG), CANCELLED);
  assert.deepEqual(lostReasonFor(false, SLUG), OTHER);
  // Both codes are the MARKETING vocabulary's own, not new ones.
  for (const code of ['CUSTOMER_CANCELLED', 'OTHER']) assert.ok(MARKETING_DROPOFF_REASON_CODES.includes(code), code);
  // A record that signed and moved on (wasWon from its history) is a cancelled customer too.
  assert.deepEqual(plan('cancelled', { pipelineStatus: 'TRIAL_EXPIRED', wasWon: true, trialEndsAt: TRIAL_ENDED }), move('DEAL_LOST', CANCELLED));
});

test('a reactivation wins a lost customer back where they were: signed if they had signed, else a new trial', () => {
  assert.deepEqual(plan('reactivated', { pipelineStatus: 'DEAL_LOST', wasWon: true }), winBack('DEAL_WON'));
  assert.deepEqual(plan('reactivated', { pipelineStatus: 'DEAL_LOST', wasWon: false }), winBack('TRIAL_ACTIVE'));
});

test('a closed record is never reopened in place', () => {
  const closedWon = { status: 'COMPLETED', pipelineStatus: 'DEAL_WON' };
  assert.deepEqual(plan('trial_started', closedWon), winBack('TRIAL_ACTIVE', true));
  assert.deepEqual(plan('converted', closedWon), refused('DEAL_WON'));
  assert.equal(plan('cancelled', closedWon), NOTHING);
  assert.equal(plan('reactivated', closedWon), NOTHING);

  const closedLost = { status: 'COMPLETED', pipelineStatus: 'DEAL_LOST' };
  assert.deepEqual(plan('account_created', closedLost), winBack('TRIAL_ACTIVE', true));
  assert.deepEqual(plan('converted', closedLost), winBack('DEAL_WON', true));
  assert.equal(plan('deactivated', closedLost), NOTHING);
  assert.deepEqual(plan('reactivated', closedLost), winBack('TRIAL_ACTIVE', true));
});

test('a stage the org does not have is a conflict, never a write of an unknown key', () => {
  const noLost = STAGES.filter((s) => s.key !== 'DEAL_LOST');
  assert.deepEqual(plan('cancelled', { pipelineStatus: 'TRIAL_ACTIVE' }, { stages: noLost }), { kind: 'missing_stage', stage: 'DEAL_LOST' });
  const noTrial = STAGES.filter((s) => s.key !== 'TRIAL_ACTIVE');
  assert.deepEqual(plan('trial_started', { pipelineStatus: 'DEAL_LOST' }, { stages: noTrial }), { kind: 'missing_stage', stage: 'TRIAL_ACTIVE' });
  assert.deepEqual(plan('trial_started', { pipelineStatus: 'LEAD_NEW' }, { stages: noTrial }), { kind: 'missing_stage', stage: 'TRIAL_ACTIVE' });
  const noWon = STAGES.filter((s) => s.key !== 'DEAL_WON');
  assert.deepEqual(plan('reactivated', { pipelineStatus: 'DEAL_LOST', wasWon: true }, { stages: noWon }), { kind: 'missing_stage', stage: 'DEAL_WON' });
});

test('a batch is processed by external id, then by when each event happened, then as sent', () => {
  const at = (iso) => new Date(iso);
  const events = [
    { external_id: 'b-2', occurred_at: at('2024-03-01T00:00:00Z') },
    { external_id: 'a-1', occurred_at: at('2024-05-01T00:00:00Z') },
    { external_id: 'b-2', occurred_at: at('2024-01-01T00:00:00Z') },
    { external_id: 'a-1', occurred_at: at('2024-02-01T00:00:00Z') },
    { external_id: 'a-1', occurred_at: at('2024-02-01T00:00:00Z') },
    { external_id: 'a-10', occurred_at: at('2020-01-01T00:00:00Z') },
  ];
  assert.deepEqual(batchOrder(events), [3, 4, 1, 5, 2, 0]);
  assert.deepEqual(batchOrder([]), []);
  assert.equal(ACCOUNT_EVENT_BATCH_MAX, 200);
});
