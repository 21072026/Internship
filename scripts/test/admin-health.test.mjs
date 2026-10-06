// Unit tests for the admin health monitor's pure rules (#1902): the one next
// action per row, the worst-first order, and the 7-day crossing count.
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { nextActionFor, compareHealthRows, DROPOFF_SILENCE_DAYS } = await import('../../src/lib/healthNextAction.ts');
const { crossedIntoRiskSince } = await import('../../src/lib/relationHealthTrend.ts');

const base = { relationId: 'r1', menteeId: 'e1', mentorId: 'm1', mentorActive: true, reasons: [], daysSinceContact: 3, ageDays: 100 };

test('a deactivated mentor means reassign, whatever else is wrong', () => {
  const a = nextActionFor({ ...base, mentorActive: false, reasons: ['unanswered_question', 'overdue'] });
  assert.deepEqual(a, { kind: 'reassign', href: '/admin/mentorship?transfer=r1' });
});

test('two months of silence asks for a drop-off reason — counted from the start when there was never contact', () => {
  assert.equal(nextActionFor({ ...base, reasons: ['inactive'], daysSinceContact: DROPOFF_SILENCE_DAYS }).kind, 'record_dropoff');
  assert.equal(nextActionFor({ ...base, reasons: ['inactive'], daysSinceContact: null, ageDays: 90 }).kind, 'record_dropoff');
  assert.equal(nextActionFor({ ...base, reasons: ['inactive'], daysSinceContact: null, ageDays: 20 }).kind, 'message_mentor');
  assert.equal(nextActionFor({ ...base, reasons: ['inactive'], daysSinceContact: 59 }).kind, 'message_mentor');
});

test('a waiting mentee beats a passed deadline; a passed deadline beats drift', () => {
  assert.equal(nextActionFor({ ...base, reasons: ['overdue', 'pending_meeting'] }).kind, 'message_mentor');
  assert.equal(nextActionFor({ ...base, reasons: ['overdue', 'no_open_goal'] }).kind, 'set_deadline');
  assert.equal(nextActionFor({ ...base, reasons: ['missing_weekly_reports'] }).kind, 'message_mentor');
  assert.equal(nextActionFor({ ...base, reasons: ['stage_stalled'] }).kind, 'set_deadline');
});

test('every action is a destination; nothing to do means no action', () => {
  assert.equal(nextActionFor({ ...base, reasons: [] }), null);
  assert.equal(nextActionFor({ ...base, reasons: ['overdue'] }).href, '/admin/candidates/e1#relation-stage');
  assert.equal(nextActionFor({ ...base, reasons: ['inactive'] }).href, '/admin/mentors/m1');
  for (const reasons of [['inactive'], ['overdue'], ['unanswered_question'], ['pending_meeting'], ['no_open_goal'], ['missing_weekly_reports'], ['stage_stalled']]) {
    assert.ok(nextActionFor({ ...base, reasons })?.href.startsWith('/admin/'), reasons.join());
  }
});

test('worst first: band, then score (unscored last in its band), then reasons, then silence', () => {
  const row = (relationId, band, score, reasons = ['inactive'], daysSinceContact = 1) => ({ relationId, band, score, reasons, daysSinceContact });
  const sorted = [
    row('h', 'HEALTHY', 90),
    row('w', 'WATCH', 55),
    row('new', 'AT_RISK', null),
    row('r2', 'AT_RISK', 20, ['inactive']),
    row('r1', 'AT_RISK', 20, ['inactive', 'overdue']),
    row('r0', 'AT_RISK', 10),
    row('never', 'AT_RISK', 20, ['inactive'], null),
  ].sort(compareHealthRows);
  assert.deepEqual(sorted.map((r) => r.relationId), ['r0', 'r1', 'never', 'r2', 'new', 'w', 'h']);
});

test('a crossing is an AT_RISK day after a non-AT_RISK one, inside the window', () => {
  const d = (s) => new Date(`2026-10-${s}T00:00:00Z`);
  const since = d('05');
  assert.equal(crossedIntoRiskSince([{ takenOn: d('04'), band: 'WATCH' }, { takenOn: d('05'), band: 'AT_RISK' }], since), true);
  // Red all along: not a crossing.
  assert.equal(crossedIntoRiskSince([{ takenOn: d('03'), band: 'AT_RISK' }, { takenOn: d('06'), band: 'AT_RISK' }], since), false);
  // Crossed before the window.
  assert.equal(crossedIntoRiskSince([{ takenOn: d('01'), band: 'WATCH' }, { takenOn: d('02'), band: 'AT_RISK' }, { takenOn: d('06'), band: 'AT_RISK' }], since), false);
  // A single snapshot has no "before": a baseline, not a crossing.
  assert.equal(crossedIntoRiskSince([{ takenOn: d('06'), band: 'AT_RISK' }], since), false);
  // Order of input does not matter.
  assert.equal(crossedIntoRiskSince([{ takenOn: d('07'), band: 'AT_RISK' }, { takenOn: d('06'), band: 'HEALTHY' }], since), true);
});
