// The marketing price list (src/lib/marketingPlans.ts) is published on
// /pricing and quoted by the landing FAQ, so its shape is pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MARKETING_PLANS,
  MARKETING_PLAN_KEYS,
  marketingFromSeatEur,
  marketingFirstYearMinimumEur,
} from '../../src/lib/marketingPlans.ts';

test('one plan per key, in key order', () => {
  assert.deepEqual(MARKETING_PLANS.map((p) => p.key), [...MARKETING_PLAN_KEYS]);
});

test('each plan costs more per seat than the one before it', () => {
  for (let i = 1; i < MARKETING_PLANS.length; i++) {
    assert.ok(MARKETING_PLANS[i].annualSeatEur > MARKETING_PLANS[i - 1].annualSeatEur);
    assert.ok(MARKETING_PLANS[i].minSeats >= MARKETING_PLANS[i - 1].minSeats);
  }
});

test('a monthly contract is never cheaper than the annual one', () => {
  for (const p of MARKETING_PLANS) {
    if (p.monthlySeatEur != null) assert.ok(p.monthlySeatEur > p.annualSeatEur, p.key);
    assert.ok(Number.isInteger(p.annualSeatEur) && p.annualSeatEur > 0);
    assert.ok(Number.isInteger(p.onboardingEur) && p.onboardingEur >= 0);
    assert.ok(Number.isInteger(p.minSeats) && p.minSeats >= 1);
  }
});

test('the FAQ "from" price is the cheapest annual seat', () => {
  assert.equal(marketingFromSeatEur(), Math.min(...MARKETING_PLANS.map((p) => p.annualSeatEur)));
});

test('first-year minimum = seat × 12 × min seats + onboarding', () => {
  const team = MARKETING_PLANS.find((p) => p.key === 'team');
  assert.equal(marketingFirstYearMinimumEur(team), team.annualSeatEur * 12 * team.minSeats + team.onboardingEur);
});
