// Grounded outreach drafts (#2048, part 2) — moment, facts block, bulk limits, parsing. Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BULK_DRAFT_MAX_RECIPIENTS,
  bulkRefusal,
  factsBlock,
  firstName,
  parseDraft,
  pickMoment,
} from '../../src/lib/outreachRules.ts';

const facts = (o = {}) => ({
  menteeFirstName: 'Ada',
  stageLabel: 'Interview',
  firstStage: false,
  dormant: false,
  outcome: null,
  openGoals: ['Finish the CV', 'Apply to three roles', 'Mock interview', 'Fourth goal'],
  lastMeetingAt: '2026-10-01T09:00:00.000Z',
  lastMessageAt: null,
  mentorHasWritten: true,
  ...o,
});

test('the moment: an outcome first, then dormancy, else the first message', () => {
  assert.equal(pickMoment(facts({ outcome: 'noMatch', dormant: true })), 'outcome_note');
  assert.equal(pickMoment(facts({ dormant: true })), 'dormant_nudge');
  assert.equal(pickMoment(facts({ mentorHasWritten: false })), 'first_message');
  assert.equal(pickMoment(facts()), 'first_message');
});

test('the facts block carries only the listed facts, at most three goals, in a stable order', () => {
  const block = factsBlock(facts());
  assert.equal(block.split('\n').length, 8);
  assert.match(block, /^First name: Ada$/m);
  assert.match(block, /Open goals: Finish the CV; Apply to three roles; Mock interview$/m);
  assert.doesNotMatch(block, /Fourth goal/);
  assert.match(block, /Last meeting: 2026-10-01$/m);
  assert.match(block, /Last message in the thread: none$/m);
  assert.equal(factsBlock(facts()), block, 'deterministic — it is the cache key');
  assert.match(factsBlock(facts({ firstStage: true, openGoals: [] })), /\(first stage — nothing has started yet\)[\s\S]*Open goals: none/);
});

test('first names, and the bulk limits refused before any call', () => {
  assert.equal(firstName('  Ada   Lovelace '), 'Ada');
  assert.equal(firstName(null), '');
  assert.equal(bulkRefusal(0), 'no_recipients');
  assert.equal(bulkRefusal(1.5), 'no_recipients');
  assert.equal(bulkRefusal(1), null);
  assert.equal(bulkRefusal(BULK_DRAFT_MAX_RECIPIENTS), null);
  assert.equal(bulkRefusal(BULK_DRAFT_MAX_RECIPIENTS + 1), 'batch_too_large');
});

test('a draft is parsed from JSON, and prose still becomes an editable body', () => {
  assert.deepEqual(parseDraft('{"subject":" Hi ","body":" Hello {name} "}'), { subject: 'Hi', body: 'Hello {name}' });
  assert.deepEqual(parseDraft('Just text'), { subject: '', body: 'Just text' });
  assert.deepEqual(parseDraft('{"subject":"x"}'), { subject: '', body: '{"subject":"x"}' });
});
