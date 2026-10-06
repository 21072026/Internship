// Unit tests for the relationship-health rules table (#1898).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// What these pin: the four scenarios the issue names (thriving, silent,
// brand-new, dormant), that a missing signal drops out instead of scoring
// zero, and that the flags keep the mentor attention queue's exact semantics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { scoreRelation, HEALTH_RULES, HEALTH_RULES_VERSION, bandFor, missingWeeklyReports } = await import('../../src/lib/relationHealth.ts');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-07T12:00:00Z'); // a Wednesday
const ago = (days) => new Date(NOW - days * DAY);

const base = {
  now: NOW,
  reminderDays: 14,
  status: 'ACTIVE',
  dormant: false,
  startDate: ago(200),
  lastContactAt: ago(2),
  stageDeadline: null,
  unansweredQuestions: 0,
  pendingMeetingRequests: 0,
  hasOpenWork: true,
  weeklyReports: null,
  lastStageMoveAt: ago(10),
};

test('the table is complete and versioned: weights sum to 100, every rule explains itself', () => {
  assert.equal(HEALTH_RULES.reduce((n, r) => n + r.weight, 0), 100);
  assert.equal(typeof HEALTH_RULES_VERSION, 'number');
  for (const r of HEALTH_RULES) {
    assert.ok(r.window.length > 0, `${r.key} window`);
    assert.ok(r.describe.length > 20 && r.describe.endsWith('.'), `${r.key} describe is one sentence`);
  }
  assert.equal(new Set(HEALTH_RULES.map((r) => r.key)).size, HEALTH_RULES.length);
});

test('a thriving pair is healthy with no reasons', () => {
  const r = scoreRelation(base);
  assert.equal(r.excluded, false);
  assert.equal(r.score, 100);
  assert.equal(r.band, 'HEALTHY');
  assert.deepEqual(r.reasons, []);
});

test('a silent pair is at risk, and says why', () => {
  const r = scoreRelation({
    ...base,
    lastContactAt: ago(60),
    stageDeadline: ago(5),
    unansweredQuestions: 1,
    pendingMeetingRequests: 1,
    hasOpenWork: false,
    lastStageMoveAt: ago(120),
  });
  assert.equal(r.band, 'AT_RISK');
  assert.ok(r.score < 40);
  assert.deepEqual(r.reasons, ['inactive', 'overdue', 'unanswered_question', 'pending_meeting', 'no_open_goal', 'stage_stalled']);
});

test('a brand-new pair with no data is neutral — missing signals drop out, they do not score zero', () => {
  const r = scoreRelation({ ...base, startDate: ago(3), lastContactAt: null, hasOpenWork: false, lastStageMoveAt: null });
  assert.equal(r.band, 'HEALTHY');
  assert.equal(r.score, 100);
  const nulls = r.contributions.filter((c) => c.points === null).map((c) => c.key);
  assert.deepEqual(nulls, ['recent_contact', 'stage_deadline', 'open_work', 'weekly_reports', 'stage_movement']);
  // …but the attention flags keep their meaning: nobody has been in touch yet,
  // and nothing is open — exactly what the mentor queue has always said.
  assert.deepEqual(r.reasons, ['inactive', 'no_open_goal']);
});

test('dormant first contacts and non-active relations are excluded, not flagged', () => {
  assert.deepEqual(scoreRelation({ ...base, dormant: true }), { excluded: true, why: 'dormant', version: HEALTH_RULES_VERSION });
  assert.deepEqual(scoreRelation({ ...base, status: 'COMPLETED' }), { excluded: true, why: 'not_active', version: HEALTH_RULES_VERSION });
});

test('contact decays in two steps across the reminder window', () => {
  const pts = (days) => scoreRelation({ ...base, lastContactAt: ago(days) }).contributions.find((c) => c.key === 'recent_contact').points;
  assert.equal(pts(14), 25);
  assert.equal(pts(20), 12.5);
  assert.equal(pts(29), 0);
  // The window is the org's setting, not a constant.
  assert.equal(scoreRelation({ ...base, reminderDays: 30, lastContactAt: ago(20) }).contributions[0].points, 25);
});

test('weekly reports: owed only when both of the last two full weeks are missing', () => {
  const thisMonday = Date.parse('2026-10-05T00:00:00Z');
  const lastWeek = thisMonday - 7 * DAY;
  const weekBefore = thisMonday - 14 * DAY;
  assert.equal(missingWeeklyReports(ago(60), [], NOW), true);
  assert.equal(missingWeeklyReports(ago(60), [lastWeek], NOW), false);
  assert.equal(missingWeeklyReports(ago(60), [weekBefore], NOW), false);
  // Too new to owe two weeks yet.
  assert.equal(missingWeeklyReports(ago(9), [], NOW), false);
  const r = scoreRelation({ ...base, weeklyReports: { submittedWeekStarts: [] } });
  assert.ok(r.reasons.includes('missing_weekly_reports'));
});

test('bands', () => {
  assert.equal(bandFor(70), 'HEALTHY');
  assert.equal(bandFor(69), 'WATCH');
  assert.equal(bandFor(40), 'WATCH');
  assert.equal(bandFor(39), 'AT_RISK');
});

test('docs/relationship-health.md publishes every rule with its weight and the current version', async () => {
  const { readFileSync } = await import('node:fs');
  const doc = readFileSync(new URL('../../docs/relationship-health.md', import.meta.url), 'utf8');
  for (const r of HEALTH_RULES) {
    assert.match(doc, new RegExp(`\\| \`${r.key}\` \\| ${r.weight} \\|`), `${r.key} row with weight ${r.weight}`);
  }
  assert.match(doc, new RegExp(`## The rules \\(version ${HEALTH_RULES_VERSION}\\)`));
  assert.match(doc, /deterministic/);
});
