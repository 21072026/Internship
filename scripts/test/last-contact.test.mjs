// Unit tests for the "what counts as contact" rule (#2275).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// The bug these pin down: a mentor exchanging in-app messages with a mentee all
// week still saw "no recent contact" next to their name, because only
// InteractionLog rows were consulted. The two edges the rule turns on are the
// interesting part:
//   - a GROUP message somebody ELSE wrote is not contact with this mentee (one
//     broadcast into a project channel must not silence the whole queue), but
//   - a GROUP message the MENTEE wrote themselves is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLastContacts, daysSince } from '../../src/lib/lastContactRule.ts';

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-09-01T00:00:00Z').getTime();
const at = (days) => new Date(T0 + days * DAY);

const RELATIONS = [
  { id: 'rel-a', menteeId: 'mentee-a' },
  { id: 'rel-b', menteeId: 'mentee-b' },
];
const EMPTY = { interactions: [], directMessages: [], menteeGroupPosts: [] };

test('a 1:1 message is contact, and beats an older logged interaction', () => {
  const result = resolveLastContacts(RELATIONS, {
    ...EMPTY,
    interactions: [{ relationId: 'rel-a', at: at(1) }],
    directMessages: [{ relationId: 'rel-a', at: at(9) }],
  });

  assert.deepEqual(result.get('rel-a'), { at: at(9), source: 'direct_message' });
});

test('a logged interaction still wins when it is the newer of the two', () => {
  const result = resolveLastContacts(RELATIONS, {
    ...EMPTY,
    interactions: [{ relationId: 'rel-a', at: at(9) }],
    directMessages: [{ relationId: 'rel-a', at: at(1) }],
  });

  assert.deepEqual(result.get('rel-a'), { at: at(9), source: 'interaction' });
});

test("a mentee's own group post counts as contact", () => {
  const result = resolveLastContacts(RELATIONS, {
    ...EMPTY,
    menteeGroupPosts: [{ menteeId: 'mentee-a', at: at(5) }],
  });

  assert.deepEqual(result.get('rel-a'), { at: at(5), source: 'group_message' });
});

test("somebody else's group post is not contact with this mentee", () => {
  // mentee-b posted in the group; rel-a's mentee did not. Only rel-b gets a
  // timestamp — this is the broadcast case that must NOT clear the queue.
  const result = resolveLastContacts(RELATIONS, {
    ...EMPTY,
    menteeGroupPosts: [{ menteeId: 'mentee-b', at: at(5) }],
  });

  assert.equal(result.get('rel-a'), undefined);
  assert.deepEqual(result.get('rel-b'), { at: at(5), source: 'group_message' });
});

test("a mentee's group post applies to every mentorship they are in", () => {
  const relations = [
    { id: 'rel-1', menteeId: 'mentee-a' },
    { id: 'rel-2', menteeId: 'mentee-a' },
  ];
  const result = resolveLastContacts(relations, {
    ...EMPTY,
    menteeGroupPosts: [{ menteeId: 'mentee-a', at: at(3) }],
  });

  assert.equal(result.get('rel-1').at.getTime(), at(3).getTime());
  assert.equal(result.get('rel-2').at.getTime(), at(3).getTime());
});

test('the newest of several group posts by the same mentee wins', () => {
  const result = resolveLastContacts(RELATIONS, {
    ...EMPTY,
    menteeGroupPosts: [
      { menteeId: 'mentee-a', at: at(2) },
      { menteeId: 'mentee-a', at: at(7) },
      { menteeId: 'mentee-a', at: at(4) },
    ],
  });

  assert.equal(result.get('rel-a').at.getTime(), at(7).getTime());
});

test('signals for relations that were not asked about are ignored', () => {
  const result = resolveLastContacts([{ id: 'rel-a', menteeId: 'mentee-a' }], {
    ...EMPTY,
    interactions: [{ relationId: 'rel-z', at: at(4) }],
    directMessages: [{ relationId: 'rel-z', at: at(4) }],
  });

  assert.equal(result.size, 0);
});

test('no signals at all means no contact — not a contact of zero days ago', () => {
  const result = resolveLastContacts(RELATIONS, EMPTY);

  assert.equal(result.size, 0);
  assert.equal(daysSince(result.get('rel-a')?.at), null);
});

test('daysSince floors to whole days', () => {
  const now = at(10).getTime();
  assert.equal(daysSince(at(10), now), 0);
  assert.equal(daysSince(new Date(at(9).getTime() + 1000), now), 0);
  assert.equal(daysSince(at(9), now), 1);
  assert.equal(daysSince(at(-4), now), 14);
});
