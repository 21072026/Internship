// Clone a programme for the next intake (#1643) — the pure half. No Next, no DB.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));

const { nextTerm, suggestCloneName, cloneSlaRows, cloneEligibilityRules, cloneSteps, CLONED_CONFIG, NEVER_CLONED } = await import(
  '../../src/lib/programCloneRule.ts'
);

test('nextTerm moves the year on, both ends of a range, and leaves a yearless term alone', () => {
  assert.equal(nextTerm('2026 Spring'), '2027 Spring');
  assert.equal(nextTerm('Fall 2025'), 'Fall 2026');
  assert.equal(nextTerm('WS 2025/26'), 'WS 2026/27');
  assert.equal(nextTerm('2025-2026'), '2026-2027');
  assert.equal(nextTerm('WS 2098/99'), 'WS 2099/00');
  assert.equal(nextTerm('Spring'), 'Spring');
  assert.equal(nextTerm(''), '');
  assert.equal(nextTerm(null), '');
});

test('the suggested name moves a year in the name, else marks it as the next one', () => {
  assert.equal(suggestCloneName('Interns 2026', 'next'), 'Interns 2027');
  assert.equal(suggestCloneName('Backend track', 'next'), 'Backend track (next)');
  assert.ok(suggestCloneName('x'.repeat(200), 'next').length <= 120);
});

test('an SLA row naming a mentor never travels; the rest are re-keyed to the clone', () => {
  const rows = [
    { stageKey: 'APPLICATION_100', days: 5, wipLimit: 10, escalateAfterDays: 2, cohortId: 'src', mentorId: null },
    { stageKey: 'APPLICATION_100', days: 3, wipLimit: null, escalateAfterDays: null, cohortId: 'src', mentorId: 'mentor-1' },
  ];
  const out = cloneSlaRows(rows, 'org-1', 'new');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    orgId: 'org-1', stageKey: 'APPLICATION_100', days: 5, wipLimit: 10, escalateAfterDays: 2,
    cohortId: 'new', mentorId: null, scope: 'c:new',
  });
});

test('eligibility rules are copied as they are, authored by whoever cloned them', () => {
  const out = cloneEligibilityRules(
    [{ effect: 'ALLOW', attribute: 'city', operator: 'IN', value: ['Berlin'], priority: 2, active: false, appliesTo: 'BOTH' }],
    'org-1', 'new', 'admin-9',
  );
  assert.deepEqual(out, [{
    orgId: 'org-1', programId: 'new', effect: 'ALLOW', attribute: 'city', operator: 'IN', value: ['Berlin'],
    priority: 2, active: false, appliesTo: 'BOTH', createdById: 'admin-9',
  }]);
});

test('archived journey steps stay behind; the rest keep order and published state', () => {
  const published = new Date('2026-01-01T00:00:00Z');
  const base = { milestone: null, anchor: 'RELATION_START', offsetDays: 7, audience: 'BOTH', action: 'NUDGE', payload: null, translations: null };
  const out = cloneSteps([
    { ...base, order: 0, title: 'Kick-off', publishedAt: published, archivedAt: null },
    { ...base, order: 1, title: 'Old step', publishedAt: null, archivedAt: published },
  ], 'org-1', 'new');
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Kick-off');
  assert.equal(out[0].programId, 'new');
  assert.equal(out[0].publishedAt, published);
  assert.equal('archivedAt' in out[0], false);
  assert.equal('id' in out[0], false);
});

test('the copied and never-copied lists do not overlap, and relations are never copied', () => {
  for (const t of NEVER_CLONED) assert.equal(CLONED_CONFIG.includes(t), false, t);
  assert.ok(NEVER_CLONED.includes('MentorshipRelation'));
});
