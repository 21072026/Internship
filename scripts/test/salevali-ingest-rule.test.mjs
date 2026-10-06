// Unit tests for what a SaleVali account event means (#2450/#2451).
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXTERNAL_ID_PATTERN,
  SALEVALI_EVENT_TYPES,
  accountNameFor,
  contactFullName,
  ingestIntent,
  ingestTrialWindow,
  isStaleEvent,
} from '../../src/lib/salevaliIngestRule.ts';

test('only the decided events act on the funnel; every other type is recorded', () => {
  assert.deepEqual(ingestIntent('account_created'), { kind: 'open_trial', toStage: 'TRIAL_ACTIVE' });
  assert.deepEqual(ingestIntent('trial_started'), { kind: 'open_trial', toStage: 'TRIAL_ACTIVE' });
  assert.deepEqual(ingestIntent('converted'), { kind: 'won', toStage: 'DEAL_WON' });
  const acting = new Set(['account_created', 'trial_started', 'converted']);
  for (const type of SALEVALI_EVENT_TYPES) {
    if (!acting.has(type)) assert.deepEqual(ingestIntent(type), { kind: 'record' }, type);
  }
});

test('the external id is K-1: 24 lower-case hex, nothing else', () => {
  assert.ok(EXTERNAL_ID_PATTERN.test('0123456789abcdef01234567'));
  assert.ok(!EXTERNAL_ID_PATTERN.test('0123456789ABCDEF01234567'));
  assert.ok(!EXTERNAL_ID_PATTERN.test('1042'), 'user_number is a label, not a key');
});

test('a new account is named after the company, else the person, else the SaleVali id', () => {
  assert.equal(accountNameFor('abc', { company_name: ' Shop GmbH ', name: 'A' }), 'Shop GmbH');
  assert.equal(accountNameFor('abc', { name: ' Ada ', surname: 'Lovelace' }), 'Ada Lovelace');
  assert.equal(accountNameFor('abc', null), 'SaleVali abc');
  assert.equal(contactFullName({ name: 'Ada', surname: null }), 'Ada');
});

test("SaleVali's trial dates fill gaps but never overwrite a date the record carries", () => {
  const d = (n) => new Date(Date.UTC(2026, 9, n));
  const event = { trialStartedAt: d(1), trialEndsAt: d(31) };
  const fallback = { trialStartedAt: d(5), trialEndsAt: d(35) };
  assert.deepEqual(ingestTrialWindow({ trialStartedAt: null, trialEndsAt: null }, event, fallback), event);
  assert.deepEqual(ingestTrialWindow({ trialStartedAt: d(2), trialEndsAt: d(20) }, event, fallback), {});
  assert.deepEqual(ingestTrialWindow({ trialStartedAt: d(2), trialEndsAt: null }, event, fallback), { trialEndsAt: d(31) });
  // The CRM's own rule only fills what neither side has.
  assert.deepEqual(
    ingestTrialWindow({ trialStartedAt: null, trialEndsAt: null }, { trialStartedAt: null, trialEndsAt: null }, fallback),
    fallback,
  );
});

test('an event older than the newest APPLIED one is stale; none applied yet is never stale', () => {
  const now = new Date('2026-10-06T10:00:00Z');
  assert.equal(isStaleEvent(new Date('2026-10-05T10:00:00Z'), now), true);
  assert.equal(isStaleEvent(new Date('2026-10-07T10:00:00Z'), now), false);
  assert.equal(isStaleEvent(now, now), false);
  assert.equal(isStaleEvent(now, null), false);
});
