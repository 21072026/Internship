// Build a minimal RFC-5545 VCALENDAR for a single meeting, or a subscribable
// multi-event feed (#915).
function toICSDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

export function buildMeetingIcs(opts: {
  uid: string;
  title: string;
  start: Date;
  durationMinutes?: number;
  description?: string | null;
  location?: string | null;
  // What the file is *for* (#2015). PUBLISH is a read-only "here is an event";
  // REQUEST is an invitation, which is what a mailed attachment has to be for a
  // client to offer "add to calendar"; CANCEL is what makes a client actually
  // remove an event it already has — and it only does so when the UID matches
  // and the SEQUENCE is higher than the one it stored. Defaults to PUBLISH, so
  // the public token route keeps meaning exactly what it meant before.
  method?: 'PUBLISH' | 'REQUEST' | 'CANCEL';
  // Bumped on every change to the same UID. A reschedule or a cancellation with
  // a stale sequence is silently ignored by the client, which is the ghost event
  // this epic exists to kill.
  sequence?: number;
}): string {
  const end = new Date(opts.start.getTime() + (opts.durationMinutes ?? 30) * 60000);
  const method = opts.method ?? 'PUBLISH';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//InternshipCRM//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${opts.uid}@crm.ersah.in`,
    `DTSTAMP:${toICSDate(new Date())}`,
    `DTSTART:${toICSDate(opts.start)}`,
    `DTEND:${toICSDate(end)}`,
    `SEQUENCE:${opts.sequence ?? 0}`,
    ...(method === 'CANCEL' ? ['STATUS:CANCELLED'] : []),
    `SUMMARY:${escapeText(opts.title)}`,
    ...(opts.description ? [`DESCRIPTION:${escapeText(opts.description)}`] : []),
    ...(opts.location ? [`LOCATION:${escapeText(opts.location)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join('\r\n');
}

// The personal subscription feed (#915). Deliberately PII-minimal: title and
// time only, no join links, no names — if the feed token leaks, this is all it
// buys. X-WR-CALNAME labels the subscription in the calendar app.
export function buildFeedIcs(name: string, events: { uid: string; title: string; start: Date; durationMinutes?: number }[]): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//InternshipCRM//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    ...events.flatMap((e) => {
      const end = new Date(e.start.getTime() + (e.durationMinutes ?? 30) * 60000);
      return [
        'BEGIN:VEVENT',
        `UID:${e.uid}@crm.ersah.in`,
        `DTSTAMP:${toICSDate(new Date())}`,
        `DTSTART:${toICSDate(e.start)}`,
        `DTEND:${toICSDate(end)}`,
        `SUMMARY:${escapeText(e.title)}`,
        'END:VEVENT',
      ];
    }),
    'END:VCALENDAR',
  ];
  return lines.join('\r\n');
}
