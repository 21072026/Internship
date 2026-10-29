// The Graph event body for one meeting (#1991) — pure, no Prisma, no network,
// so the zone arithmetic is unit-tested (e2e/microsoft-calendar-event.unit.spec.ts).
//
// Graph's `start`/`end` are a LOCAL wall clock plus a time-zone name — not a
// UTC instant with a zone glued on. Sending "2026-10-25T08:00:00Z" with
// timeZone "Europe/Berlin" makes Outlook read 08:00 Berlin, an hour off in
// summer and two in winter. So the wall clock is computed IN the zone, which
// is also what keeps a meeting right across a DST change.

import { meetingEnd } from '@/lib/meetingDuration';

export interface GraphEventInput {
  title: string;
  scheduledAt: Date;
  timeZone: string | null;
  meetLink: string | null;
  durationMinutes: number | null;
}

function isZone(tz: string | null): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "YYYY-MM-DDTHH:mm:ss" — the wall clock `date` shows in `timeZone`. */
export function graphDateTime(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function graphEventBody(meeting: GraphEventInput, product: string) {
  // An unknown or absent zone is written as UTC — a correct instant, merely
  // shown in the reader's own zone by Outlook.
  const timeZone = isZone(meeting.timeZone) ? meeting.timeZone : 'UTC';
  const start = meeting.scheduledAt;
  const end = meetingEnd(start, meeting);
  const link = meeting.meetLink ? escapeHtml(meeting.meetLink) : null;
  return {
    subject: meeting.title,
    body: {
      contentType: 'HTML',
      content: link ? `<p>Join: <a href="${link}">${link}</a></p><p>${escapeHtml(product)}</p>` : `<p>${escapeHtml(product)}</p>`,
    },
    start: { dateTime: graphDateTime(start, timeZone), timeZone },
    end: { dateTime: graphDateTime(end, timeZone), timeZone },
    ...(meeting.meetLink ? { location: { displayName: meeting.meetLink } } : {}),
  };
}
