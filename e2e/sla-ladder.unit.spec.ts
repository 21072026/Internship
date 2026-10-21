import { test, expect } from '@playwright/test';
import {
  SLA_LEVEL_ADMIN,
  SLA_LEVEL_MENTOR,
  daysOverdue,
  escalationDue,
  mentorAlreadyTold,
  nextEscalationAt,
  validSnooze,
} from '@/lib/slaLadderRule';

// #1722 — the escalation ladder's rule, browserless.

const DAY = 24 * 60 * 60 * 1000;
const due = new Date('2026-10-01T09:00:00Z');
const at = (days: number) => new Date(due.getTime() + days * DAY);
const open = { level: SLA_LEVEL_MENTOR, dueAt: due, acknowledgedAt: null, snoozedUntil: null };

test.describe('SLA escalation ladder rule', { tag: '@smoke' }, () => {
  test('climbs to the administrators once escalateAfterDays have passed, and never beyond', () => {
    expect(escalationDue(open, 3, at(2.9))).toBe(false);
    expect(escalationDue(open, 3, at(3))).toBe(true);
    // The top rung is never repeated.
    expect(escalationDue({ ...open, level: SLA_LEVEL_ADMIN }, 3, at(30))).toBe(false);
    expect(nextEscalationAt({ ...open, level: SLA_LEVEL_ADMIN }, 3)).toBeNull();
  });

  test('no escalation configured means the ladder stops at the mentor', () => {
    expect(escalationDue(open, null, at(365))).toBe(false);
    expect(escalationDue(open, undefined, at(365))).toBe(false);
    expect(escalationDue(open, 0, at(365))).toBe(false);
  });

  test('acknowledged stops the climb; a snooze holds it until it ends', () => {
    expect(escalationDue({ ...open, acknowledgedAt: at(1) }, 3, at(10))).toBe(false);
    const snoozed = { ...open, snoozedUntil: at(7) };
    expect(escalationDue(snoozed, 3, at(5))).toBe(false);
    expect(escalationDue(snoozed, 3, at(7))).toBe(true);
  });

  test('a deadline already reminded about is adopted, not re-sent', () => {
    expect(mentorAlreadyTold(new Date())).toBe(true);
    expect(mentorAlreadyTold(null)).toBe(false);
  });

  test('days overdue and snooze bounds', () => {
    expect(daysOverdue(due, at(0.2))).toBe(1);
    expect(daysOverdue(due, at(4.5))).toBe(4);
    expect(validSnooze(at(1), at(0))).toBe(true);
    expect(validSnooze(at(0), at(0))).toBe(false);
    expect(validSnooze(at(91), at(0))).toBe(false);
  });
});
