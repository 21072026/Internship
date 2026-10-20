import { test, expect } from '@playwright/test';
import {
  JOURNEY_LOOKBACK_DAYS,
  isDeliverable,
  isLiveStep,
  isSafeContentUrl,
  journeyStepStatus,
  journeyTemplate,
  readStepPayload,
  recipientsFor,
  resolveDueAt,
  satisfiedReason,
  stepTitle,
  stepUnresolvable,
} from '@/lib/programJourneyRule';

// The program journey rule (#1852) — no browser, no database. When a step is
// due, whether it may still be delivered, and when it is already satisfied.

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-10-20T07:10:00Z');
const facts = (relationStart: Date, stageEntries: [string, Date][] = []) => ({ relationStart, programStart: null, stageEntries: new Map(stageEntries) });
const stages = new Set(['LEAD_IN', 'ON_THE_JOB']);

test('a step at start + 42 days is due on day 42, and only inside the lookback window', { tag: '@smoke' }, async () => {
  const step = { anchor: 'RELATION_START', offsetDays: 42 };
  const started = new Date(now.getTime() - 42 * DAY);
  const due = resolveDueAt(step, facts(started), stages);
  expect(due).toEqual({ kind: 'due', dueAt: now });
  expect(isDeliverable(now, now)).toBe(true);
  // Not yet: tomorrow's step.
  expect(isDeliverable(new Date(now.getTime() + DAY), now)).toBe(false);
  // No backfill: a step that fell due before the window is never delivered.
  expect(isDeliverable(new Date(now.getTime() - JOURNEY_LOOKBACK_DAYS * DAY), now)).toBe(true);
  expect(isDeliverable(new Date(now.getTime() - (JOURNEY_LOOKBACK_DAYS + 1) * DAY), now)).toBe(false);
});

test('a stage-anchored step resolves against the org’s own stages and degrades honestly', async () => {
  const step = { anchor: 'STAGE_ENTRY', offsetDays: 3, payload: { stageKey: 'ON_THE_JOB' } };
  const entered = new Date(now.getTime() - 3 * DAY);
  expect(resolveDueAt(step, facts(new Date(0), [['ON_THE_JOB', entered]]), stages)).toEqual({ kind: 'due', dueAt: now });
  expect(resolveDueAt(step, facts(new Date(0)), stages)).toEqual({ kind: 'unresolved', reason: 'stage_not_entered' });
  // A built-in key a custom pipeline does not have is NOT matched to anything.
  const builtIn = { anchor: 'STAGE_ENTRY', offsetDays: 0, payload: { stageKey: 'INTERNSHIP_IN_PROGRESS_450' } };
  expect(stepUnresolvable(builtIn, stages)).toBe('stage_not_in_pipeline');
  expect(resolveDueAt(builtIn, facts(new Date(0), [['INTERNSHIP_IN_PROGRESS_450', now]]), stages)).toEqual({ kind: 'unresolved', reason: 'stage_not_in_pipeline' });
  expect(stepUnresolvable({ anchor: 'PROGRAM_START', offsetDays: 0 }, stages)).toBe('program_has_no_start');
  expect(stepUnresolvable({ anchor: 'SOMEDAY', offsetDays: 0 }, stages)).toBe('invalid_step');
  expect(stepUnresolvable({ anchor: 'RELATION_START', offsetDays: 5000 }, stages)).toBe('invalid_step');
});

test('a satisfied step names its reason; the vocabularies are whitelists', async () => {
  expect(satisfiedReason({ payload: { skipIf: 'meeting_exists' } }, { meeting_exists: true })).toBe('satisfied:meeting_exists');
  expect(satisfiedReason({ payload: { skipIf: 'meeting_exists' } }, { meeting_exists: false })).toBeNull();
  expect(satisfiedReason({ payload: { skipIf: 'rm -rf' } }, {})).toBeNull();
  expect(readStepPayload({ url: 'javascript:alert(1)', skipIf: 'nope', stageKey: 'X' })).toEqual({ stageKey: 'X' });
  expect(isSafeContentUrl('/resources/week-6')).toBe(true);
  expect(isSafeContentUrl('//evil.example')).toBe(false);
  expect(isSafeContentUrl('https://user:pw@docs.example')).toBe(false);
  expect(isSafeContentUrl('http://docs.example')).toBe(false);
  expect(recipientsFor('BOTH', { mentorId: 'm', menteeId: 'e' })).toEqual(['m', 'e']);
  expect(recipientsFor('EVERYONE', { mentorId: 'm', menteeId: 'e' })).toEqual([]);
  expect(isLiveStep({ publishedAt: null, archivedAt: null, action: 'NUDGE' }, now)).toBe(false);
  expect(isLiveStep({ publishedAt: now, archivedAt: now, action: 'NUDGE' }, now)).toBe(false);
  expect(isLiveStep({ publishedAt: now, archivedAt: null, action: 'SEND_MONEY' }, now)).toBe(false);
  expect(stepTitle({ title: 'Week 6 check-in', translations: { tr: '6. hafta' } }, 'tr')).toBe('6. hafta');
  expect(stepTitle({ title: 'Week 6 check-in', translations: { tr: '6. hafta' } }, 'de')).toBe('Week 6 check-in');
});

test('the preview status says what the sweep would do; a template is a plain data copy', async () => {
  const step = { anchor: 'RELATION_START', offsetDays: 3, payload: { skipIf: 'goal_exists' }, publishedAt: now, archivedAt: null, action: 'NUDGE' };
  const started = (daysAgo: number) => facts(new Date(now.getTime() - daysAgo * DAY));
  expect(journeyStepStatus(step, null, started(3), stages, {}, now).status).toBe('due');
  expect(journeyStepStatus(step, null, started(3), stages, { goal_exists: true }, now)).toMatchObject({ status: 'would_skip', reason: 'satisfied:goal_exists' });
  expect(journeyStepStatus(step, null, started(1), stages, {}, now).status).toBe('upcoming');
  expect(journeyStepStatus(step, null, started(30), stages, {}, now).status).toBe('missed');
  expect(journeyStepStatus({ ...step, publishedAt: null }, null, started(3), stages, {}, now).status).toBe('draft');
  expect(journeyStepStatus(step, { deliveredAt: now, skippedReason: null, dueAt: now }, started(3), stages, {}, now).status).toBe('delivered');
  expect(journeyStepStatus({ ...step, anchor: 'STAGE_ENTRY', payload: { stageKey: 'ON_THE_JOB' } }, null, started(3), stages, {}, now).status).toBe('waiting');

  const tpl = journeyTemplate([
    { order: 5, milestone: 'Month 1', anchor: 'RELATION_START', offsetDays: 7, audience: 'MENTEE', action: 'ASSIGN_TODO', payload: { skipIf: 'goal_exists', junk: 1 }, title: 'First goal', translations: { de: 'Erstes Ziel', xx: 'no' } },
    { order: 1, anchor: 'RELATION_START', offsetDays: 1, audience: 'BOTH', action: 'NUDGE', title: 'Hello', archivedAt: now },
  ]);
  expect(tpl).toEqual([{ order: 0, milestone: 'Month 1', anchor: 'RELATION_START', offsetDays: 7, audience: 'MENTEE', action: 'ASSIGN_TODO', payload: { skipIf: 'goal_exists' }, title: 'First goal', translations: { de: 'Erstes Ziel' } }]);
  expect(JSON.parse(JSON.stringify(tpl))).toEqual(tpl);
});
