// The Graph event body (#1991): Graph takes a LOCAL wall clock plus a zone
// name, so the arithmetic has to happen in the zone — and stay right across a
// DST change, which a same-zone test never notices. Pure node, no browser.
import { test, expect } from '@playwright/test';
import { graphDateTime, graphEventBody } from '@/lib/calendar/microsoftEvent';

test.describe('graph event body', { tag: '@smoke' }, () => {
  test('a Berlin meeting is written as Berlin wall clock, both sides of DST', () => {
    // 09:00 UTC is 11:00 in Berlin summer time (CEST, +2)…
    const summer = new Date('2026-10-24T09:00:00Z');
    expect(graphDateTime(summer, 'Europe/Berlin')).toBe('2026-10-24T11:00:00');
    // …and 10:00 one day after the clocks went back (CET, +1).
    const winter = new Date('2026-10-26T09:00:00Z');
    expect(graphDateTime(winter, 'Europe/Berlin')).toBe('2026-10-26T10:00:00');
  });

  test('a meeting spanning the DST night keeps its real length', () => {
    // 00:30 → 03:30 UTC on 2026-10-25: Berlin reads 02:30 CEST → 04:30 CET.
    const body = graphEventBody(
      { title: 'Night shift', scheduledAt: new Date('2026-10-25T00:30:00Z'), timeZone: 'Europe/Berlin', meetLink: null, durationMinutes: 180 },
      'Acme Sales'
    );
    expect(body.start).toEqual({ dateTime: '2026-10-25T02:30:00', timeZone: 'Europe/Berlin' });
    expect(body.end).toEqual({ dateTime: '2026-10-25T04:30:00', timeZone: 'Europe/Berlin' });
  });

  test('no zone, or an unknown one, is written as UTC — never a glued-on zone', () => {
    const at = new Date('2026-12-01T15:45:00Z');
    for (const timeZone of [null, 'Mars/Olympus']) {
      const body = graphEventBody({ title: 'T', scheduledAt: at, timeZone, meetLink: null, durationMinutes: 30 }, 'P');
      expect(body.start).toEqual({ dateTime: '2026-12-01T15:45:00', timeZone: 'UTC' });
      expect(body.end).toEqual({ dateTime: '2026-12-01T16:15:00', timeZone: 'UTC' });
    }
  });

  test('the join link is escaped into the HTML body and becomes the location', () => {
    const body = graphEventBody(
      { title: 'T', scheduledAt: new Date('2026-12-01T15:45:00Z'), timeZone: 'UTC', meetLink: 'https://meet.example/a?b=1&c="x"', durationMinutes: null },
      'Acme <Sales>'
    );
    expect(body.body.contentType).toBe('HTML');
    expect(body.body.content).toContain('https://meet.example/a?b=1&amp;c=&quot;x&quot;');
    expect(body.body.content).toContain('Acme &lt;Sales&gt;');
    expect(body.location).toEqual({ displayName: 'https://meet.example/a?b=1&c="x"' });
  });
});
