// When a meeting reminder fires (#1636): src/lib/meetingReminderLeads.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_MEETING_LEADS,
  LEGACY_SERIES_LEADS,
  dueLead,
  isValidLeadList,
  leadsFor,
  parseLeadList,
  readRemindedLeads,
  writeRemindedLeads,
  legacyLeadEnum,
} from '../../src/lib/meetingReminderLeads.ts';

// The pre-#1636 series rule, verbatim, to prove the legacy leads reproduce it.
function oldLeadFor(minutesAway) {
  if (minutesAway <= 60) return 'HOUR_BEFORE';
  if (minutesAway >= 23 * 60) return 'DAY_BEFORE';
  return null;
}

test('nothing configured reproduces the old series rule over the 25h lookahead', () => {
  for (let m = 0.5; m <= 25 * 60; m += 0.5) {
    const lead = dueLead(m, leadsFor({ configured: null, legacy: LEGACY_SERIES_LEADS }));
    assert.equal(lead === null ? null : legacyLeadEnum(lead), oldLeadFor(m), `at ${m} minutes`);
  }
});

test('nothing configured reproduces the one-hour one-off reminder', () => {
  const leads = leadsFor({ configured: null, legacy: LEGACY_MEETING_LEADS });
  assert.deepEqual(leads, [60]);
  assert.equal(dueLead(60, leads), 60);
  assert.equal(dueLead(5, leads), 60);
  assert.equal(dueLead(61, leads), null);
  assert.equal(dueLead(30, leads, new Set([60])), null);
});

test('a programme with a single 30-minute lead sends exactly one, 30 minutes ahead', () => {
  const leads = leadsFor({ configured: parseLeadList('30'), legacy: LEGACY_MEETING_LEADS });
  assert.equal(dueLead(45, leads), null);
  assert.equal(dueLead(30, leads), 30);
  assert.equal(dueLead(20, leads, new Set([30])), null);
});

test('a per-meeting lead overrides the programme; 0 means none', () => {
  assert.deepEqual(leadsFor({ override: 1440, configured: [30], legacy: LEGACY_MEETING_LEADS }), [1440]);
  assert.deepEqual(leadsFor({ override: 0, configured: [30], legacy: LEGACY_MEETING_LEADS }), []);
  assert.equal(dueLead(10, []), null);
});

test('a meeting booked late never gets a late "tomorrow"', () => {
  const leads = [1440, 60];
  assert.equal(dueLead(300, leads), null); // five hours ahead: neither
  assert.equal(dueLead(50, leads), 60);
  // …and once the hour lead is sent, the day lead never fires afterwards.
  assert.equal(dueLead(40, leads, new Set([60])), null);
});

test('each lead fires once; the larger one first', () => {
  const leads = [1440, 60];
  const sent = new Set();
  const fired = [];
  for (let m = 1500; m > 0; m -= 15) {
    const lead = dueLead(m, leads, sent);
    if (lead !== null) {
      sent.add(lead);
      fired.push(lead);
    }
  }
  assert.deepEqual(fired, [1440, 60]);
});

test('lead lists parse, validate and round-trip', () => {
  assert.deepEqual(parseLeadList('60, 1440,60'), [1440, 60]);
  assert.equal(parseLeadList(''), null);
  assert.equal(parseLeadList('0, 99999'), null);
  assert.ok(isValidLeadList('1440, 60'));
  assert.ok(isValidLeadList(''));
  assert.ok(!isValidLeadList('1, 2, 3, 4, 5'));
  assert.ok(!isValidLeadList('abc'));
  assert.ok(!isValidLeadList('3000'));
  assert.deepEqual([...readRemindedLeads(writeRemindedLeads(new Set([60, 1440])))].sort(), [1440, 60]);
  assert.equal(readRemindedLeads(null).size, 0);
});
