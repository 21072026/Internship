// Unit tests for src/lib/contractEndRule.ts — a won customer's notice period
// (#2841, decision #2572 option C).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { CONTRACT_STAGE_KEY, contractEndReminderDue, isCancellationPending, parseContractEndDate, planContractEndChange } =
  await import('../../src/lib/contractEndRule.ts');

const NOW = new Date('2026-10-07T10:00:00Z');
const day = (s) => parseContractEndDate(s);

test('only a won record carries a contract end', () => {
  assert.equal(CONTRACT_STAGE_KEY, 'DEAL_WON');
  assert.deepEqual(planContractEndChange({ pipelineStatus: 'TRIAL_ACTIVE', current: null, next: day('2026-12-31'), now: NOW }), { ok: false, error: 'not_won' });
  assert.deepEqual(planContractEndChange({ pipelineStatus: 'DEAL_LOST', current: null, next: null, now: NOW }), { ok: false, error: 'not_won' });
});

test('a new date is today or later; a bad one is refused', () => {
  assert.deepEqual(planContractEndChange({ pipelineStatus: 'DEAL_WON', current: null, next: day('2026-10-06'), now: NOW }), { ok: false, error: 'in_the_past' });
  assert.deepEqual(planContractEndChange({ pipelineStatus: 'DEAL_WON', current: null, next: null, invalid: true, now: NOW }), { ok: false, error: 'invalid_date' });
  const today = planContractEndChange({ pipelineStatus: 'DEAL_WON', current: null, next: day('2026-10-07'), now: NOW });
  assert.equal(today.ok && today.changed, true);
});

test('clearing is always allowed on a won record; the same date is no change', () => {
  const cleared = planContractEndChange({ pipelineStatus: 'DEAL_WON', current: day('2026-12-31'), next: null, now: NOW });
  assert.deepEqual(cleared, { ok: true, changed: true, contractEndsAt: null });
  const same = planContractEndChange({ pipelineStatus: 'DEAL_WON', current: day('2026-12-31'), next: day('2026-12-31'), now: NOW });
  assert.equal(same.ok && same.changed, false);
  const noneToNone = planContractEndChange({ pipelineStatus: 'DEAL_WON', current: null, next: null, now: NOW });
  assert.equal(noneToNone.ok && noneToNone.changed, false);
});

test('cancellation pending = won + a date', () => {
  assert.equal(isCancellationPending({ pipelineStatus: 'DEAL_WON', contractEndsAt: day('2026-12-31') }), true);
  assert.equal(isCancellationPending({ pipelineStatus: 'DEAL_WON', contractEndsAt: null }), false);
  assert.equal(isCancellationPending({ pipelineStatus: 'DEAL_LOST', contractEndsAt: day('2026-12-31') }), false);
});

test('the end-day bell: due on and after the day, once', () => {
  const base = { pipelineStatus: 'DEAL_WON', contractEndRemindedAt: null, now: NOW };
  assert.equal(contractEndReminderDue({ ...base, contractEndsAt: day('2026-10-07') }), true);
  assert.equal(contractEndReminderDue({ ...base, contractEndsAt: day('2026-10-01') }), true);
  assert.equal(contractEndReminderDue({ ...base, contractEndsAt: day('2026-10-08') }), false);
  assert.equal(contractEndReminderDue({ ...base, contractEndsAt: day('2026-10-07'), contractEndRemindedAt: NOW }), false);
  assert.equal(contractEndReminderDue({ ...base, pipelineStatus: 'DEAL_LOST', contractEndsAt: day('2026-10-07') }), false);
});
