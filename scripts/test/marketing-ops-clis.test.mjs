// Unit tests for the two MARKETING operator CLIs (#2959):
//   prisma/apply-marketing-stage-preset.mjs — bring a tenant to the current preset
//   prisma/wipe-integration-source.mjs      — roll one integration source back
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// Both CLIs run inside the runtime image (node:20-slim, no src/), so the rules
// they need are plain-ESM MIRRORS of TypeScript under src/. This file is what
// keeps a mirror honest: it loads the TS original and compares — a change to
// the preset, its service levels, the apply refusals or the lead stand-in
// constants turns it red until the mirror follows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import {
  MARKETING_PRESET_STAGES,
  MARKETING_PRESET_SLAS,
  planStagePreset,
  describePlan,
} from '../../prisma/apply-marketing-stage-preset.mjs';
import {
  LEAD_NO_LOGIN_PASSWORD,
  STAND_IN_EMAIL_DOMAIN,
  SAME_INSERT_SLACK_MS,
  classifyAccount,
  isLeadStandIn,
  totalCounts,
  sourceActivityWhere,
} from '../../prisma/wipe-integration-source.mjs';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { defaultTemplateForVertical, templateStagePayload, templateSlaPayload, templateApplyBlockers } = await import(
  '../../src/lib/programTemplates.ts'
);
const { NO_LOGIN_PASSWORD, PLACEHOLDER_EMAIL_DOMAIN } = await import('../../src/lib/menteeAccount.ts');

const preset = defaultTemplateForVertical('MARKETING');

// ── The mirrors ──────────────────────────────────────────────────────────────

test('the preset stages are templateStagePayload(MARKETING), field for field', () => {
  assert.deepEqual(MARKETING_PRESET_STAGES, templateStagePayload(preset, 'en').stages);
});

test('the preset service levels are templateSlaPayload(MARKETING), field for field', () => {
  assert.deepEqual(MARKETING_PRESET_SLAS, templateSlaPayload(preset).slas);
});

test('the lead stand-in constants are the ones src/lib/menteeAccount.ts writes', () => {
  assert.equal(LEAD_NO_LOGIN_PASSWORD, NO_LOGIN_PASSWORD);
  assert.equal(STAND_IN_EMAIL_DOMAIN, PLACEHOLDER_EMAIL_DOMAIN);
});

// ── apply-marketing-stage-preset ────────────────────────────────────────────

// The set a MARKETING org was provisioned with before the trial pair and before
// #2840 removed the proposal / negotiation steps.
const OLD_SET = [
  { key: 'LEAD_NEW', label: 'New lead', order: 0, isTerminal: false, isOffPath: false, color: '#2563eb' },
  { key: 'LEAD_CONTACTED', label: 'Contacted', order: 1, isTerminal: false, isOffPath: false, color: '#0ea5e9' },
  { key: 'LEAD_QUALIFIED', label: 'Qualified', order: 2, isTerminal: false, isOffPath: false, color: '#8b5cf6' },
  { key: 'DEAL_PROPOSAL', label: 'Proposal sent', order: 3, isTerminal: false, isOffPath: false, color: '#f59e0b' },
  { key: 'DEAL_NEGOTIATION', label: 'Negotiation', order: 4, isTerminal: false, isOffPath: false, color: '#f97316' },
  { key: 'DEAL_WON', label: 'Won', order: 5, isTerminal: true, isOffPath: false, color: '#16a34a' },
  { key: 'DEAL_LOST', label: 'Lost', order: 6, isTerminal: true, isOffPath: true, color: '#6b7280' },
];

test('an org already on the preset (no service levels) only gets the preset SLAs', () => {
  const plan = planStagePreset({ current: MARKETING_PRESET_STAGES, occupied: {}, slaRows: [] });
  assert.ok(plan.stages.every((s) => s.action === 'unchanged'));
  assert.deepEqual(plan.removals, []);
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(
    plan.slas.filter((s) => s.action === 'create').map((s) => [s.stageKey, s.after.days]),
    [['LEAD_NEW', 1], ['LEAD_CONTACTED', 3], ['LEAD_QUALIFIED', 7], ['TRIAL_EXPIRED', 7]],
  );
});

test('a second run after a full apply has nothing to do', () => {
  const slaRows = MARKETING_PRESET_SLAS.filter((s) => s.days != null).map((s) => ({ ...s, wipLimit: null }));
  const plan = planStagePreset({ current: MARKETING_PRESET_STAGES, occupied: { LEAD_NEW: 3 }, slaRows });
  assert.equal(plan.changes, 0);
});

test('the pre-#2840 set: trial pair created, orders moved, unused retired keys deleted', () => {
  const plan = planStagePreset({ current: OLD_SET, occupied: { LEAD_NEW: 2, DEAL_WON: 1 }, slaRows: [] });
  assert.deepEqual(plan.blockers, []);
  const by = Object.fromEntries(plan.stages.map((s) => [s.key, s]));
  assert.equal(by.TRIAL_ACTIVE.action, 'create');
  assert.equal(by.TRIAL_EXPIRED.action, 'create');
  assert.equal(by.LEAD_NEW.action, 'unchanged');
  assert.equal(by.DEAL_WON.action, 'unchanged'); // order 5 in both
  assert.deepEqual(plan.removals.map((r) => r.key), ['DEAL_PROPOSAL', 'DEAL_NEGOTIATION']);
  assert.ok(describePlan(plan).includes('+ TRIAL_ACTIVE'));
  assert.ok(describePlan(plan).includes('- DEAL_PROPOSAL'));
});

test('a tenant-typed label or colour is brought back to the preset, and shown as a change', () => {
  const current = MARKETING_PRESET_STAGES.map((s) => (s.key === 'LEAD_NEW' ? { ...s, label: ' Fresh ', color: ' ' } : s));
  const lead = planStagePreset({ current, occupied: {}, slaRows: [] }).stages.find((s) => s.key === 'LEAD_NEW');
  assert.equal(lead.action, 'update');
  assert.deepEqual(lead.changed, ['label', 'color']);
  assert.equal(lead.before.label, 'Fresh'); // trimmed like replaceStages()
  assert.equal(lead.before.color, null);
});

test('a retired key with records or a service level refuses the run — the same refusals as templateApplyBlockers()', () => {
  const cases = [
    { occupied: { DEAL_PROPOSAL: 2 }, slaRows: [] },
    { occupied: {}, slaRows: [{ stageKey: 'DEAL_NEGOTIATION', days: 7, wipLimit: null }] },
    { occupied: { DEAL_PROPOSAL: 1 }, slaRows: [{ stageKey: 'DEAL_PROPOSAL', days: null, wipLimit: 4 }] },
    // A key with records but no stage row at all is stranded too.
    { occupied: { APPLICATION_100: 1 }, slaRows: [] },
    { occupied: { LEAD_NEW: 5 }, slaRows: [{ stageKey: 'LEAD_NEW', days: 2, wipLimit: null }] },
  ];
  for (const c of cases) {
    const plan = planStagePreset({ current: OLD_SET, ...c });
    const reasons = [...new Set(plan.blockers.map((b) => b.reason))].sort();
    const ts = templateApplyBlockers(preset, {
      existingStageCount: OLD_SET.length,
      occupiedStageKeys: Object.keys(c.occupied),
      configuredSlaKeys: c.slaRows.map((r) => r.stageKey),
      confirmed: true,
    }).sort();
    assert.deepEqual(reasons, ts, JSON.stringify(c));
  }
  const refused = planStagePreset({ current: OLD_SET, occupied: { DEAL_PROPOSAL: 2 }, slaRows: [] });
  assert.ok(refused.removals.find((r) => r.key === 'DEAL_PROPOSAL').blocked);
  assert.match(describePlan(refused), /REFUSED[\s\S]*DEAL_PROPOSAL: 2 funnel record/);
});

test('service levels follow PUT /api/admin/stage-sla: wipLimit kept, an emptied row deleted', () => {
  const slaRows = [
    { stageKey: 'LEAD_NEW', days: 2, wipLimit: 10 }, // days to the preset, WIP kept
    { stageKey: 'TRIAL_ACTIVE', days: 5, wipLimit: null }, // preset has none → row deleted
    { stageKey: 'DEAL_WON', days: 3, wipLimit: 0 }, // preset has none, WIP 0 is a statement → kept
  ];
  const by = Object.fromEntries(planStagePreset({ current: MARKETING_PRESET_STAGES, occupied: {}, slaRows }).slas.map((s) => [s.stageKey, s]));
  assert.deepEqual([by.LEAD_NEW.action, by.LEAD_NEW.after], ['update', { days: 1, wipLimit: 10 }]);
  assert.equal(by.TRIAL_ACTIVE.action, 'delete');
  assert.deepEqual([by.DEAL_WON.action, by.DEAL_WON.after], ['update', { days: null, wipLimit: 0 }]);
  assert.equal(by.DEAL_LOST.action, 'unchanged');
});

// ── wipe-integration-source ─────────────────────────────────────────────────

const ORG = 'org-1';
const T0 = new Date('2026-10-19T10:00:00Z');
const later = (ms) => new Date(T0.getTime() + ms);
const standIn = (id, over = {}) => ({
  id,
  orgId: ORG,
  role: 'MENTEE',
  password: LEAD_NO_LOGIN_PASSWORD,
  email: `lead-${id}@${STAND_IN_EMAIL_DOMAIN}`,
  createdAt: later(20),
  relationIds: ['r1'],
  ...over,
});
const noWork = { interactionLog: 0, relationNote: 0, statusChangeByPerson: 0, otherUsers: 0 };
const counts = { statusChanges: 1, activityLogs: 2, integrationEvents: 3, contactPermissions: 1, companyChannels: 0 };
const fresh = (over = {}) => ({
  account: { id: 'c1', createdAt: T0 },
  relations: [{ id: 'r1', menteeId: 'u1', startDate: later(30) }],
  leads: [standIn('u1')],
  humanWork: noWork,
  counts,
  orgId: ORG,
  ...over,
});

test('isLeadStandIn: only a password-less MENTEE on the stand-in domain of this org', () => {
  assert.ok(isLeadStandIn(standIn('u1'), ORG));
  assert.ok(!isLeadStandIn(standIn('u1'), 'org-2'));
  assert.ok(!isLeadStandIn(standIn('u1', { password: '$2b$10$hash' }), ORG));
  assert.ok(!isLeadStandIn(standIn('u1', { role: 'MENTOR' }), ORG));
  assert.ok(!isLeadStandIn(standIn('u1', { email: 'person@shop.example' }), ORG));
});

test('an account the feed created and nobody worked on is wiped with its lead', () => {
  const v = classifyAccount(fresh());
  assert.equal(v.action, 'wipe');
  assert.deepEqual(v.leadIds, ['u1']);
  assert.deepEqual(v.counts, {
    companies: 1, relations: 1, statusChanges: 1, leadUsers: 1, contactPermissions: 1, companyChannels: 0, activityLogs: 2, integrationEvents: 3,
  });
});

test('human work keeps the account, and says why', () => {
  for (const key of ['interactionLog', 'statusChangeByPerson', 'otherUsers', 'companyContact']) {
    const v = classifyAccount(fresh({ humanWork: { ...noWork, [key]: 2 } }));
    assert.equal(v.action, 'keep', key);
    assert.deepEqual(v.reasons, [`${key}: 2`]);
  }
});

test('a lead that existed before, or has a record elsewhere, is kept — the account still goes', () => {
  const older = classifyAccount(fresh({ leads: [standIn('u1', { createdAt: new Date(T0.getTime() - SAME_INSERT_SLACK_MS - 1) })] }));
  assert.equal(older.action, 'wipe');
  assert.deepEqual([older.leadIds, older.keptLeadIds], [[], ['u1']]);
  const elsewhere = classifyAccount(fresh({ leads: [standIn('u1', { relationIds: ['r1', 'r-other'] })] }));
  assert.deepEqual([elsewhere.leadIds, elsewhere.keptLeadIds], [[], ['u1']]);
  const person = classifyAccount(fresh({ leads: [standIn('u1', { email: 'person@shop.example' })] }));
  assert.deepEqual(person.keptLeadIds, ['u1']);
});

test('a record of an older lead that started before the account was re-pointed, not created: keep', () => {
  const v = classifyAccount(
    fresh({
      leads: [standIn('u1', { createdAt: new Date('2026-01-01') })],
      relations: [{ id: 'r1', menteeId: 'u1', startDate: new Date('2026-02-01') }],
    }),
  );
  assert.equal(v.action, 'keep');
  assert.deepEqual(v.reasons, ['records that predate the account: 1']);
});

test('totals add the wiped accounts and the source-wide rows, never a kept account', () => {
  const wiped = classifyAccount(fresh());
  const kept = classifyAccount(fresh({ humanWork: { ...noWork, interactionLog: 1 } }));
  const t = totalCounts([wiped, kept], { activityLogs: 4, integrationEvents: 5 });
  assert.equal(t.companies, 1);
  assert.equal(t.activityLogs, 6);
  assert.equal(t.integrationEvents, 8);
});

test('the source-wide activity filter names the slug with its separator, so "feed" never matches "feed-2"', () => {
  const w = sourceActivityWhere(ORG, 'feed');
  assert.equal(w.detail.startsWith, 'feed: ');
  assert.equal(w.orgId, ORG);
  assert.equal(sourceActivityWhere(ORG, 'feed', ['r1']).OR[1].targetId.notIn[0], 'r1');
});
