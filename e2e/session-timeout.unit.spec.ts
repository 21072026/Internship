import { test, expect } from '@playwright/test';
import { SESSION_WARNING_LEAD_MS, minutesLeft, planSessionWarning } from '../src/lib/sessionTimeoutRule';

// WCAG 2.2.1 (#2864): when the "your session is about to end" dialog opens.
test.describe('session timeout warning rule', { tag: '@smoke' }, () => {
  const now = Date.parse('2026-10-27T12:00:00Z');
  const at = (ms: number) => new Date(now + ms).toISOString();

  test('waits until five minutes before the end', () => {
    expect(planSessionWarning(at(12 * 3600_000), now)).toEqual({ kind: 'wait', delayMs: 12 * 3600_000 - SESSION_WARNING_LEAD_MS });
    expect(planSessionWarning(at(SESSION_WARNING_LEAD_MS + 1), now)).toEqual({ kind: 'wait', delayMs: 1 });
  });

  test('warns inside the window, with the time left — at least 20 s to respond', () => {
    expect(SESSION_WARNING_LEAD_MS).toBeGreaterThanOrEqual(20_000);
    expect(planSessionWarning(at(SESSION_WARNING_LEAD_MS), now)).toEqual({ kind: 'warn', remainingMs: SESSION_WARNING_LEAD_MS });
    expect(planSessionWarning(at(1), now)).toEqual({ kind: 'warn', remainingMs: 1 });
  });

  test('an ended or unreadable session plans nothing', () => {
    expect(planSessionWarning(at(0), now)).toEqual({ kind: 'expired' });
    expect(planSessionWarning(at(-1000), now)).toEqual({ kind: 'expired' });
    expect(planSessionWarning(undefined, now)).toEqual({ kind: 'unknown' });
    expect(planSessionWarning('not a date', now)).toEqual({ kind: 'unknown' });
  });

  test('minutes left round up and never read 0', () => {
    expect(minutesLeft(SESSION_WARNING_LEAD_MS)).toBe(5);
    expect(minutesLeft(4 * 60_000 + 1)).toBe(5);
    expect(minutesLeft(500)).toBe(1);
  });
});
