import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./ts-extensionless-resolve.mjs', import.meta.url);

const { resolveEvaluationSchedule, evaluationReminderDue, dueDateIsCreatable, EVALUATION_MAX_REMINDERS } = await import('../../src/lib/evaluationDueRule.ts');

const DAY = 24 * 60 * 60 * 1000;
const builtIn = new Set(['APPLICATION_100', 'INTERNSHIP_IN_PROGRESS_450', 'INTERNSHIP_COMPLETED_490']);
const custom = new Set(['LEAD_IN', 'ON_THE_JOB', 'WRAPPED_UP']);

test('unconfigured: the built-in default, but only where the pipeline has the key', () => {
  assert.deepEqual(resolveEvaluationSchedule({ interimStage: '', interimDays: '30', finalStage: '' }, builtIn), {
    INTERIM: { stageKey: 'INTERNSHIP_IN_PROGRESS_450', afterDays: 30 },
    FINAL: { stageKey: 'INTERNSHIP_COMPLETED_490', afterDays: 0 },
  });
  // A custom pipeline gets no guess.
  assert.deepEqual(resolveEvaluationSchedule({ interimStage: '', interimDays: '30', finalStage: '' }, custom), { INTERIM: null, FINAL: null });
});

test('configured: the org\'s own keys, "off" switches a type off, an unknown key never fires', () => {
  assert.deepEqual(resolveEvaluationSchedule({ interimStage: 'ON_THE_JOB', interimDays: '21', finalStage: 'WRAPPED_UP' }, custom), {
    INTERIM: { stageKey: 'ON_THE_JOB', afterDays: 21 },
    FINAL: { stageKey: 'WRAPPED_UP', afterDays: 0 },
  });
  assert.equal(resolveEvaluationSchedule({ interimStage: 'off', interimDays: '30', finalStage: '' }, builtIn).INTERIM, null);
  assert.equal(resolveEvaluationSchedule({ interimStage: 'GONE_STAGE', interimDays: '30', finalStage: '' }, custom).INTERIM, null);
  // Nonsense days fall back to the default.
  assert.equal(resolveEvaluationSchedule({ interimStage: '', interimDays: 'x', finalStage: '' }, builtIn).INTERIM.afterDays, 30);
});

test('reminders: on the due date, a week later, never a third', () => {
  const due = new Date('2026-10-01T00:00:00Z');
  const at = (d) => new Date(due.getTime() + d * DAY);
  const row = (remindersSent, lastRemindedAt = null, completedAt = null) => ({ dueAt: due, remindersSent, lastRemindedAt, completedAt });
  assert.equal(evaluationReminderDue(row(0), at(-1)), false);
  assert.equal(evaluationReminderDue(row(0), at(0)), true);
  assert.equal(evaluationReminderDue(row(1, at(0)), at(6)), false);
  assert.equal(evaluationReminderDue(row(1, at(0)), at(7)), true);
  // A first reminder sent late (day 5) pushes the second to day 12, not day 7.
  assert.equal(evaluationReminderDue(row(1, at(5)), at(8)), false);
  assert.equal(evaluationReminderDue(row(1, at(5)), at(12)), true);
  assert.equal(evaluationReminderDue(row(EVALUATION_MAX_REMINDERS, at(7)), at(100)), false);
  // Written: silent.
  assert.equal(evaluationReminderDue(row(0, null, at(1)), at(2)), false);
});

test('no backfill: a due date more than two weeks old is not created', () => {
  const now = new Date('2026-10-20T00:00:00Z');
  assert.equal(dueDateIsCreatable(new Date(now.getTime() - 14 * DAY), now), true);
  assert.equal(dueDateIsCreatable(new Date(now.getTime() - 15 * DAY), now), false);
  assert.equal(dueDateIsCreatable(new Date(now.getTime() + 30 * DAY), now), true);
});
