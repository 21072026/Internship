// Telling people a meeting moved or was called off (#1982).
//
// The state half lives in PATCH /api/meetings/[id] (#1980); this is the human
// half, called once per change with the rows it touched. Three rules:
//
//   · EVERYONE IT AFFECTS, ONCE. Both sides of each relation and every guest —
//     minus whoever made the change. A person in several rows of one bulk
//     session (a mentor with five mentees) is told once, not five times.
//   · ON THEIR OWN CLOCK, IN THEIR OWN LANGUAGE. A participant's in-app line and
//     mail read their saved zone and `preferredLanguage`; a guest has neither, so
//     their mail is on the organizer's clock and says so.
//   · NO NOTICE SILENTLY DROPPED. The in-app line and the mail are independent
//     channels with independent switches: silencing meeting e-mails leaves the
//     bell, silencing the bell leaves the mail.
//
// Project and conversation meetings reach no relation; their participants are
// not looked up here yet — only their guests and the organizer's counterpart.

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { notifyIfAllowed } from '@/lib/notify';
import { formatInTimeZone } from '@/lib/timezone';
import { intlLocaleFor } from '@/lib/interviewRequests';
import {
  sendMeetingCancelledEmail,
  sendMeetingGuestCancelledEmail,
  sendMeetingGuestRescheduledEmail,
  sendMeetingRescheduledEmail,
} from '@/services/emailService';

const personSelect = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  timezone: true,
  preferredLanguage: true,
  orgId: true,
} as const;

type Person = {
  id: string;
  email: string;
  fullName: string;
  role: string;
  timezone: string | null;
  preferredLanguage: string | null;
  orgId: string | null;
};

async function loadRows(ids: string[]) {
  return prisma.meeting.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      title: true,
      scheduledAt: true,
      previousScheduledAt: true,
      meetLink: true,
      timeZone: true,
      rsvpToken: true,
      createdById: true,
      relation: { select: { mentor: { select: personSelect }, mentee: { select: personSelect } } },
      guests: { select: { email: true, name: true, rsvpToken: true } },
    },
  });
}

type Row = Awaited<ReturnType<typeof loadRows>>[number];

/** Each person once, with the row they are the invitee of (for its RSVP token). */
function peopleOf(rows: Row[], actorId: string) {
  const people = new Map<string, { person: Person; row: Row; invitee: boolean }>();
  for (const row of rows) {
    const rel = row.relation;
    if (!rel) continue;
    // The row's RSVP belongs to the side that did not create it.
    const invitee = rel.mentee.id === row.createdById ? rel.mentor.id : rel.mentee.id;
    for (const p of [rel.mentor, rel.mentee]) {
      if (p.id === actorId) continue;
      const seen = people.get(p.id);
      if (!seen || (!seen.invitee && p.id === invitee)) people.set(p.id, { person: p, row, invitee: p.id === invitee });
    }
  }
  return [...people.values()];
}

function guestsOf(rows: Row[]) {
  const guests = new Map<string, { email: string; name: string | null; rsvpToken: string; row: Row }>();
  for (const row of rows) for (const g of row.guests) if (!guests.has(g.email)) guests.set(g.email, { ...g, row });
  return [...guests.values()];
}

async function organizerOf(row: Row) {
  const organizer = await prisma.user.findUnique({
    where: { id: row.createdById },
    select: { fullName: true, timezone: true, preferredLanguage: true, orgId: true },
  });
  return {
    name: organizer?.fullName ?? null,
    // The clock the time was agreed on (#1210), else the organizer's own.
    zone: row.timeZone ?? organizer?.timezone ?? null,
    locale: organizer?.preferredLanguage ?? null,
    orgId: organizer?.orgId ?? null,
  };
}

const linkFor = (p: Person) => (p.role === 'MENTEE' ? '/portal' : p.role === 'ADMIN' ? '/admin/calendar' : '/mentor/meetings');
const readOn = (at: Date, p: Person) => formatInTimeZone(at, p.timezone, undefined, intlLocaleFor(p.preferredLanguage));

/** Run one notice and log, never throw: a failed mail must not fail the change. */
async function attempt(what: string, run: () => Promise<unknown>) {
  try {
    await run();
  } catch (e) {
    logger.error('Meeting change notice failed', { what, error: String(e) });
  }
}

/** Rows that just moved: their `previousScheduledAt` is the time they left. */
export async function noticeMeetingsRescheduled(ids: string[], actorId: string) {
  if (ids.length === 0) return;
  const rows = (await loadRows(ids)).filter((r) => r.scheduledAt);
  if (rows.length === 0) return;
  const organizer = await organizerOf(rows[0]);

  for (const { person, row, invitee } of peopleOf(rows, actorId)) {
    const to = row.scheduledAt as Date;
    await attempt('inApp', () =>
      notifyIfAllowed(
        person.id,
        'meetingReminders',
        'meeting.rescheduled',
        { title: row.title, from: row.previousScheduledAt ? readOn(row.previousScheduledAt, person) : '—', to: readOn(to, person) },
        linkFor(person),
      ),
    );
    await attempt('mail', () =>
      sendMeetingRescheduledEmail({
        to: person.email,
        fullName: person.fullName,
        title: row.title,
        previousAt: row.previousScheduledAt,
        scheduledAt: to,
        meetLink: row.meetLink,
        rsvpToken: invitee ? row.rsvpToken : null,
        timeZone: person.timezone,
        organizerTimeZone: organizer.zone,
        organizerName: organizer.name,
        userId: person.id,
        locale: person.preferredLanguage,
        orgId: person.orgId,
      }),
    );
  }
  for (const guest of guestsOf(rows)) {
    await attempt('guestMail', () =>
      sendMeetingGuestRescheduledEmail({
        to: guest.email,
        name: guest.name,
        title: guest.row.title,
        previousAt: guest.row.previousScheduledAt,
        scheduledAt: guest.row.scheduledAt as Date,
        meetLink: guest.row.meetLink,
        rsvpToken: guest.rsvpToken,
        organizerTimeZone: organizer.zone,
        organizerName: organizer.name,
        locale: organizer.locale,
        orgId: organizer.orgId,
      }),
    );
  }
}

/** Rows that were just called off, with the reason the canceller gave. */
export async function noticeMeetingsCancelled(ids: string[], actorId: string, reason: string | null) {
  if (ids.length === 0) return;
  const rows = await loadRows(ids);
  if (rows.length === 0) return;
  const organizer = await organizerOf(rows[0]);
  const why = reason?.trim() || null;

  for (const { person, row } of peopleOf(rows, actorId)) {
    const when = row.scheduledAt ? readOn(row.scheduledAt, person) : '—';
    await attempt('inApp', () =>
      notifyIfAllowed(
        person.id,
        'meetingReminders',
        why ? 'meeting.cancelledReason' : 'meeting.cancelled',
        why ? { title: row.title, when, reason: why } : { title: row.title, when },
        linkFor(person),
      ),
    );
    await attempt('mail', () =>
      sendMeetingCancelledEmail({
        to: person.email,
        fullName: person.fullName,
        title: row.title,
        scheduledAt: row.scheduledAt,
        reason: why,
        timeZone: person.timezone,
        organizerTimeZone: organizer.zone,
        organizerName: organizer.name,
        userId: person.id,
        locale: person.preferredLanguage,
        orgId: person.orgId,
      }),
    );
  }
  for (const guest of guestsOf(rows)) {
    await attempt('guestMail', () =>
      sendMeetingGuestCancelledEmail({
        to: guest.email,
        name: guest.name,
        title: guest.row.title,
        scheduledAt: guest.row.scheduledAt,
        reason: why,
        organizerTimeZone: organizer.zone,
        organizerName: organizer.name,
        locale: organizer.locale,
        orgId: organizer.orgId,
      }),
    );
  }
}
