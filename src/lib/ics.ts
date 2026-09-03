// Build a minimal RFC-5545 VCALENDAR for a single meeting, or a subscribable
// multi-event feed (#915).
function toICSDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

// One side of an iTIP exchange. `email` must be a bare address (no display
// name) — it goes straight into the mailto: value.
export type IcsPerson = { email: string; name?: string | null };

// A CN= parameter for an ORGANIZER/ATTENDEE line. Param values that contain
// ",", ";" or ":" have to be quoted (RFC 5545 §3.1), and a quoted param value
// cannot itself contain a double quote — so always quote, and drop any quote in
// the name rather than trying to escape it.
function cnParam(name?: string | null): string {
  const trimmed = name?.trim();
  if (!trimmed) return '';
  return `;CN="${trimmed.replace(/"/g, '')}"`;
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
  // Who is asking and who is asked. iTIP (RFC 5546 §3.2.2/§3.2.5) requires both
  // on a REQUEST *and* on a CANCEL: Outlook and Google bind a cancellation to a
  // stored event by UID **and** ORGANIZER, so a CANCEL without one is dropped
  // and the meeting stays in the calendar — the exact ghost this epic kills.
  // Gmail also needs the pair to render an invitation card with RSVP buttons
  // instead of a bare file to download. Ignored for PUBLISH, which is a
  // read-only copy with no negotiation and no participants (the public token
  // route stays byte-identical).
  organizer?: IcsPerson | null;
  attendee?: IcsPerson | null;
}): string {
  const end = new Date(opts.start.getTime() + (opts.durationMinutes ?? 30) * 60000);
  const method = opts.method ?? 'PUBLISH';
  const itip = method === 'REQUEST' || method === 'CANCEL';
  // RSVP is only meaningful while an answer is still wanted; a cancellation
  // asks nothing, it just needs the attendee named so the client knows the row
  // is theirs.
  const attendeeParams =
    method === 'REQUEST' ? ';ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE' : ';ROLE=REQ-PARTICIPANT';
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
    ...(itip && opts.organizer ? [`ORGANIZER${cnParam(opts.organizer.name)}:mailto:${opts.organizer.email}`] : []),
    ...(itip && opts.attendee
      ? [`ATTENDEE${cnParam(opts.attendee.name)}${attendeeParams}:mailto:${opts.attendee.email}`]
      : []),
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
