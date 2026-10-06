// Unit tests for the report-subscription rules (#1905): validity, period keys
// and due-ness. The period key is the idempotency key — a wrong one either
// double-sends (two keys for one period) or swallows a period (one key for two).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { subscriptionProblem, periodKey, isDue, isoWeek, isoWeekday } = await import('../../src/lib/reportSubscriptions.ts');

const base = { reportKey: 'pipeline-funnel', cadence: 'WEEKLY', dayOfWeek: 1, dayOfMonth: null, hour: 7, locale: 'de', format: 'EMAIL_SUMMARY', recipientEmail: 'dean@uni.example' };

test('a valid subscription passes; each broken field is named', () => {
  assert.equal(subscriptionProblem(base), null);
  assert.equal(subscriptionProblem({ ...base, reportKey: 'everything' }), 'unknown_report');
  assert.equal(subscriptionProblem({ ...base, cadence: 'DAILY' }), 'invalid_cadence');
  assert.equal(subscriptionProblem({ ...base, format: 'PDF' }), 'invalid_format');
  assert.equal(subscriptionProblem({ ...base, locale: 'fr' }), 'invalid_locale');
  assert.equal(subscriptionProblem({ ...base, hour: 24 }), 'invalid_hour');
  assert.equal(subscriptionProblem({ ...base, dayOfWeek: 0 }), 'invalid_day');
  assert.equal(subscriptionProblem({ ...base, cadence: 'MONTHLY', dayOfMonth: 31 }), 'invalid_day');
  assert.equal(subscriptionProblem({ ...base, cadence: 'MONTHLY', dayOfMonth: 28 }), null);
  assert.equal(subscriptionProblem({ ...base, recipientUserId: 'u1' }), 'one_recipient');
  assert.equal(subscriptionProblem({ ...base, recipientEmail: null }), 'one_recipient');
  assert.equal(subscriptionProblem({ ...base, recipientEmail: 'not-an-address' }), 'invalid_email');
});

test('ISO weeks, including the year boundary', () => {
  assert.deepEqual(isoWeek(new Date('2026-01-01T12:00:00Z')), { year: 2026, week: 1 });
  // 2027-01-01 is a Friday: it belongs to week 53 of 2026.
  assert.deepEqual(isoWeek(new Date('2027-01-01T12:00:00Z')), { year: 2026, week: 53 });
  assert.equal(isoWeekday(new Date('2026-10-05T00:00:00Z')), 1); // a Monday
  assert.equal(isoWeekday(new Date('2026-10-11T23:59:59Z')), 7); // a Sunday
});

test('one period key per week / month / quarter', () => {
  assert.equal(periodKey('WEEKLY', new Date('2026-10-05T00:00:00Z')), '2026-W41');
  assert.equal(periodKey('WEEKLY', new Date('2026-10-11T23:59:59Z')), '2026-W41');
  assert.equal(periodKey('WEEKLY', new Date('2026-10-12T00:00:00Z')), '2026-W42');
  assert.equal(periodKey('MONTHLY', new Date('2026-10-31T23:00:00Z')), '2026-10');
  assert.equal(periodKey('QUARTERLY', new Date('2026-10-01T00:00:00Z')), '2026-Q4');
  assert.equal(periodKey('QUARTERLY', new Date('2026-09-30T23:00:00Z')), '2026-Q3');
});

test('due from its hour on its day until the end of that day', () => {
  const weekly = { cadence: 'WEEKLY', dayOfWeek: 1, dayOfMonth: null, hour: 7 };
  assert.equal(isDue(weekly, new Date('2026-10-05T06:59:00Z')), false);
  assert.equal(isDue(weekly, new Date('2026-10-05T07:00:00Z')), true);
  assert.equal(isDue(weekly, new Date('2026-10-05T22:00:00Z')), true); // a missed hour still sends that day
  assert.equal(isDue(weekly, new Date('2026-10-06T07:00:00Z')), false);
  const monthly = { cadence: 'MONTHLY', dayOfWeek: null, dayOfMonth: 3, hour: 0 };
  assert.equal(isDue(monthly, new Date('2026-11-03T00:30:00Z')), true);
  assert.equal(isDue(monthly, new Date('2026-11-04T00:30:00Z')), false);
  const quarterly = { cadence: 'QUARTERLY', dayOfWeek: null, dayOfMonth: 1, hour: 9 };
  assert.equal(isDue(quarterly, new Date('2026-10-01T09:00:00Z')), true);
  assert.equal(isDue(quarterly, new Date('2026-11-01T09:00:00Z')), false);
  assert.equal(isDue({ ...weekly, cadence: 'HOURLY' }, new Date('2026-10-05T07:00:00Z')), false);
});
