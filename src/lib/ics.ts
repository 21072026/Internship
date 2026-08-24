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
}): string {
  const end = new Date(opts.start.getTime() + (opts.durationMinutes ?? 30) * 60000);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//InternshipCRM//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${opts.uid}@crm.ersah.in`,
    `DTSTAMP:${toICSDate(new Date())}`,
    `DTSTART:${toICSDate(opts.start)}`,
    `DTEND:${toICSDate(end)}`,
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
