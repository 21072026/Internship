// Group sessions (#1856): the pure rules — phases, when registration is open,
// the cap, who manages an event, and that attendance is #2014's vocabulary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
register('./ts-extensionless-resolve.mjs', import.meta.url);

const rule = await import('../../src/lib/groupEventRule.ts');

const at = (iso) => new Date(iso);
const base = { startsAt: at('2026-11-02T10:00:00Z'), durationMinutes: 60, publishedAt: at('2026-10-01T00:00:00Z'), cancelledAt: null };

test('phase: draft, cancelled, upcoming, live, past', () => {
  assert.equal(rule.eventPhase({ ...base, publishedAt: null }, at('2026-11-01T00:00:00Z')), 'draft');
  assert.equal(rule.eventPhase({ ...base, cancelledAt: at('2026-10-20T00:00:00Z') }, at('2026-11-01T00:00:00Z')), 'cancelled');
  assert.equal(rule.eventPhase(base, at('2026-11-02T09:59:59Z')), 'upcoming');
  assert.equal(rule.eventPhase(base, at('2026-11-02T10:30:00Z')), 'live');
  assert.equal(rule.eventPhase(base, at('2026-11-02T11:00:00Z')), 'past');
});

test('registration is open only before the start of a published, uncancelled event', () => {
  assert.equal(rule.registrationRefusal(base, at('2026-11-01T00:00:00Z')), null);
  assert.equal(rule.registrationRefusal({ ...base, publishedAt: null }, at('2026-11-01T00:00:00Z')), 'event_draft');
  assert.equal(rule.registrationRefusal({ ...base, cancelledAt: at('2026-10-20T00:00:00Z') }, at('2026-11-01T00:00:00Z')), 'event_cancelled');
  assert.equal(rule.registrationRefusal(base, at('2026-11-02T10:00:00Z')), 'event_started');
});

test('seats left never goes negative; an uncapped event has none to count', () => {
  assert.equal(rule.seatsLeft(10, 3), 7);
  assert.equal(rule.seatsLeft(2, 5), 0);
  assert.equal(rule.seatsLeft(null, 50), null);
});

test('a capacity edit never un-registers anybody', () => {
  assert.equal(rule.capacityRefusal(3, 4), 'capacity_below_registered');
  assert.equal(rule.capacityRefusal(4, 4), null);
  assert.equal(rule.capacityRefusal(null, 400), null);
});

test('audience by role; admins are staff, not audience', () => {
  assert.equal(rule.audienceIncludesRole('MENTEES', 'MENTEE'), true);
  assert.equal(rule.audienceIncludesRole('MENTEES', 'MENTOR'), false);
  assert.equal(rule.audienceIncludesRole('MENTORS', 'MENTOR'), true);
  assert.equal(rule.audienceIncludesRole('ALL', 'MENTOR'), true);
  assert.equal(rule.audienceIncludesRole('ALL', 'COMPANY'), false);
  assert.equal(rule.audienceIncludesRole('ALL', 'ADMIN'), false);
});

test('host or an admin of the same org manages; nobody across orgs', () => {
  const e = { hostId: 'h', orgId: 'o1' };
  assert.equal(rule.canManageEvent({ role: 'MENTOR', userId: 'h', orgId: 'o1' }, e), true);
  assert.equal(rule.canManageEvent({ role: 'MENTOR', userId: 'x', orgId: 'o1' }, e), false);
  assert.equal(rule.canManageEvent({ role: 'ADMIN', userId: 'a', orgId: 'o1' }, e), true);
  assert.equal(rule.canManageEvent({ role: 'ADMIN', userId: 'a', orgId: 'o2' }, e), false);
  assert.equal(rule.canManageEvent({ role: 'ADMIN', userId: 'a', orgId: null }, { hostId: 'h', orgId: null }), false);
  assert.equal(rule.canCreateEvent('COMPANY'), false);
});

test('attendance opens shortly before the start, never on a draft or cancelled event', () => {
  assert.equal(rule.attendanceOpen(base, at('2026-11-02T09:40:00Z')), false);
  assert.equal(rule.attendanceOpen(base, at('2026-11-02T09:50:00Z')), true);
  assert.equal(rule.attendanceOpen({ ...base, publishedAt: null }, at('2026-11-03T00:00:00Z')), false);
  assert.equal(rule.attendanceOpen({ ...base, cancelledAt: at('2026-11-01T00:00:00Z') }, at('2026-11-03T00:00:00Z')), false);
});

test("attendance is #2014's AttendanceState, never a second enum", () => {
  const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
  const enumBody = schema.match(/enum AttendanceState \{([^}]*)\}/)[1];
  const values = [...enumBody.matchAll(/^\s*([A-Z_]+)\s*$/gm)].map((m) => m[1]);
  assert.deepEqual([...rule.EVENT_ATTENDANCE_STATES].sort(), values.sort());
  assert.equal((schema.match(/^enum \w*Attendance\w* \{/gm) ?? []).length, 1);
  const reg = schema.match(/model EventRegistration \{([\s\S]*?)\n\}/)[1];
  assert.match(reg, /attendance\s+AttendanceState\?/);
  assert.doesNotMatch(reg, /rsvpToken|token/i, 'the session is the credential — no token on a registration');
});
