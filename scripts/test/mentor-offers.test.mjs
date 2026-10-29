// Unit tests for the Mentor Offers rule (#1809) — src/lib/mentorOfferRule.ts.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));

const { offerRefusal, OFFER_LIMITS, offerExpiresAt, isExpired, reminderDue } = await import('../../src/lib/mentorOfferRule.ts');

const ok = {
  mentorAvailability: 'available',
  menteeOpenToOffers: true,
  menteeHasActiveRelation: false,
  menteeHasPendingRequest: false,
  previous: null,
  mentorPendingCount: 0,
  mentorSentLast7Days: 0,
};

test('an available mentor may offer to an opted-in, unmatched mentee', () => {
  assert.equal(offerRefusal(ok), null);
});

test('a mentee who has not opted in is refused first, before anything else about them', () => {
  assert.equal(offerRefusal({ ...ok, menteeOpenToOffers: false, menteeHasActiveRelation: true }), 'not_open_to_offers');
});

test('a mentor at capacity, paused or at a self-match limit cannot offer', () => {
  for (const s of ['at_capacity', 'not_accepting', 'self_match_full']) assert.equal(offerRefusal({ ...ok, mentorAvailability: s }), 'mentor_unavailable');
});

test('a matched mentee or one with a pending request is not offerable', () => {
  assert.equal(offerRefusal({ ...ok, menteeHasActiveRelation: true }), 'mentee_matched');
  assert.equal(offerRefusal({ ...ok, menteeHasPendingRequest: true }), 'mentee_request_pending');
});

test('one mentor cannot re-offer: not while pending, not after a decline', () => {
  assert.equal(offerRefusal({ ...ok, previous: 'PENDING' }), 'already_offered');
  assert.equal(offerRefusal({ ...ok, previous: 'DECLINED' }), 'declined_before');
});

test('the quota holds: a 4th pending or a 6th in 7 days is refused', () => {
  assert.equal(OFFER_LIMITS.maxPending, 3);
  assert.equal(OFFER_LIMITS.maxPerWeek, 5);
  assert.equal(offerRefusal({ ...ok, mentorPendingCount: 2, mentorSentLast7Days: 4 }), null);
  assert.equal(offerRefusal({ ...ok, mentorPendingCount: 3 }), 'quota_pending');
  assert.equal(offerRefusal({ ...ok, mentorSentLast7Days: 5 }), 'quota_weekly');
});

test('14-day expiry and exactly one reminder in the last 3 days', () => {
  const created = new Date('2026-10-01T00:00:00Z');
  const expiresAt = offerExpiresAt(created);
  assert.equal(expiresAt.toISOString(), '2026-10-15T00:00:00.000Z');
  const offer = { status: 'PENDING', expiresAt, remindedAt: null };
  assert.equal(reminderDue(offer, new Date('2026-10-11T00:00:00Z')), false);
  assert.equal(reminderDue(offer, new Date('2026-10-12T00:00:01Z')), true);
  assert.equal(reminderDue({ ...offer, remindedAt: new Date() }, new Date('2026-10-13T00:00:00Z')), false);
  assert.equal(reminderDue(offer, new Date('2026-10-15T00:00:00Z')), false);
  assert.equal(isExpired(offer, new Date('2026-10-15T00:00:00Z')), true);
  assert.equal(isExpired({ ...offer, status: 'ACCEPTED' }, new Date('2026-11-01T00:00:00Z')), false);
});
