// Unit tests for the channel matrix, quiet hours and blackout days (#1714) —
// pure node, no browser, no database. The router enforces these rules
// (src/lib/notifications/router.ts); this pins the rules themselves.
import { test, expect } from '@playwright/test';
import { NOTIFICATION_CATEGORIES } from '@/lib/notificationPrefs';
import {
  channelOffInMatrix,
  isClosed,
  nextOpenInstant,
  parseBlackoutDates,
  readChannelMap,
  readQuietHours,
  resolveChannels,
  type Calendar,
} from '@/lib/notificationChannelPrefs';

const cal = (over: Partial<Calendar> = {}): Calendar => ({ quiet: null, tz: 'UTC', blackoutDates: [], blackoutWeekends: false, ...over });

test.describe('notification channel matrix (#1714)', { tag: '@smoke' }, () => {
  test('an account that never touched the matrix keeps the catalogue defaults', () => {
    const map = readChannelMap({ deadlines: false }, NOTIFICATION_CATEGORIES);
    expect(map).toEqual({});
    expect(resolveChannels(map, 'deadlines', ['inApp', 'email'])).toEqual(['inApp', 'email']);
  });

  test('push switched on is added; e-mail is never added; an off channel is left for the router to record', () => {
    const map = readChannelMap(
      { channels: { deadlines: { email: false, push: true }, digest: { email: true, inApp: true }, bogus: { push: true } } },
      NOTIFICATION_CATEGORIES,
    );
    expect(map).not.toHaveProperty('bogus');
    expect(resolveChannels(map, 'deadlines', ['inApp', 'email'])).toEqual(['inApp', 'email', 'push']);
    // digest sends mail only: the matrix cannot give it a bell row or more mail.
    expect(resolveChannels(map, 'digest', ['email'])).toEqual(['email']);
    expect(resolveChannels(map, 'messages', ['inApp'])).toEqual(['inApp']);
    expect(channelOffInMatrix(map, 'deadlines', 'email')).toBe(true);
    expect(channelOffInMatrix(map, 'deadlines', 'inApp')).toBe(false);
  });

  test('malformed values are ignored, not trusted', () => {
    expect(readChannelMap({ channels: { deadlines: { email: 'no', push: 1 } } }, NOTIFICATION_CATEGORIES)).toEqual({});
    expect(readChannelMap({ channels: [] }, NOTIFICATION_CATEGORIES)).toEqual({});
    expect(readQuietHours({ quietHours: { start: '25:00', end: '08:00' } })).toBeNull();
    expect(readQuietHours({ quietHours: { start: '08:00', end: '08:00' } })).toBeNull();
    expect(readQuietHours({ quietHours: { start: '21:00', end: '08:00', tz: 'Mars/Base' } })).toEqual({ start: '21:00', end: '08:00' });
  });
});

test.describe('quiet hours and blackout days (#1714)', { tag: '@smoke' }, () => {
  const night = cal({ quiet: { start: '21:00', end: '08:00' }, tz: 'Europe/Berlin' });

  test('a window across midnight is closed on both sides of it', () => {
    // 2026-10-28 is a Wednesday; Berlin is UTC+1 after the October switch.
    expect(isClosed(new Date('2026-10-28T21:30:00Z'), night)).toBe(true); // 22:30 local
    expect(isClosed(new Date('2026-10-29T05:00:00Z'), night)).toBe(true); // 06:00 local
    expect(isClosed(new Date('2026-10-29T07:00:00Z'), night)).toBe(false); // 08:00 local
    expect(isClosed(new Date('2026-10-29T12:00:00Z'), night)).toBe(false);
  });

  test('a held delivery opens exactly at the window end, and an open instant sends now', () => {
    expect(nextOpenInstant(new Date('2026-10-28T21:30:00Z'), night)?.toISOString()).toBe('2026-10-29T07:00:00.000Z');
    expect(nextOpenInstant(new Date('2026-10-29T12:00:00Z'), night)).toBeNull();
  });

  test('blackout dates and weekends hold to the next open working day', () => {
    const c = cal({ blackoutDates: parseBlackoutDates('2026-10-30, junk;2026-11-02'), blackoutWeekends: true });
    expect(c.blackoutDates).toEqual(['2026-10-30', '2026-11-02']);
    // Friday blackout, weekend, Monday blackout → Tuesday 00:00 UTC.
    expect(nextOpenInstant(new Date('2026-10-30T10:00:00Z'), c)?.toISOString()).toBe('2026-11-03T00:00:00.000Z');
  });

  test('a calendar that is never open releases instead of swallowing', () => {
    const all = cal({ quiet: { start: '00:00', end: '23:59' }, blackoutWeekends: true, blackoutDates: [] });
    const now = new Date('2026-10-29T12:00:00Z');
    const at = nextOpenInstant(now, all)!;
    expect(at.getTime() - now.getTime()).toBeLessThanOrEqual(16 * 24 * 60 * 60 * 1000);
  });
});
