import { prisma } from '@/lib/prisma';
import { dispatchWebhook } from '@/lib/webhooks';
import { isLocale, defaultLocale, type Locale } from '@/i18n/config';
import { TEXT_LIMITS } from '@/lib/textLimits';

// "The meeting we held should already be in the interaction log" (#1489).
//
// A mentor scheduled a meeting here, the meeting happened, and then they were
// expected to re-type that fact into the interaction log by hand — the app
// already knew everything the entry needed. So a relation meeting that took
// place now writes its own InteractionLog row.
//
// Two things decide "took place", both handled here:
//   • someone clicked "end meeting"  → logged immediately (POST /api/meetings/[id]/end);
//   • nobody clicked anything        → logged by the sweep below, once the
//     start time is more than GRACE_MINUTES old.
//
// Only relation meetings are logged: the interaction log hangs off a
// MentorshipRelation, and a project/conversation room (#1051) has none.
//
// The entry is a normal InteractionLog — the mentor can edit its notes or
// delete it like any other. `autoLogged` only marks where it came from, so the
// UI can say "otomatik" and nobody mistakes the placeholder note for something
// their mentor wrote.
//
// It fires the same `interaction.logged` webhook a typed entry does — an
// integration mirroring the log wants every entry — but deliberately sends the
// mentee no notification: they were in the meeting, and "your mentor logged an
// interaction" about something nobody did is noise, not news.

// How long after the start time an un-ended meeting is assumed to have
// happened. One hour is the window the dashboard banner already treats a
// meeting as in progress for (src/lib/upcomingMeeting.ts); two hours leaves
// room for one that ran long before the log claims it is over.
export const MEETING_AUTOLOG_GRACE_MINUTES = 120;

// How many meetings one sweep tick may log; the rest wait for the next tick.
// Kept small because each log dispatches a webhook, and a registered endpoint
// that hangs costs WEBHOOK_TIMEOUT_MS per entry — 50 keeps the pathological
// tick well inside its 15-minute slot.
const SWEEP_BATCH = 50;

// How far back the sweep looks. It exists to catch what the click path missed,
// not to reconstruct history: without a window, the first tick after this
// shipped would back-write a placeholder entry for every meeting ever held on
// an installation, months of them landing in mentees' journeys at once.
const SWEEP_LOOKBACK_DAYS = 30;

// The same cap for the siblings of an ended meeting. One relation meeting
// writes one row per invited mentee, so this bounds what a single "meeting is
// over" click does before it answers.
const SIBLING_BATCH = 25;

// The placeholder note. Deliberately says what the system knows (the meeting
// was held) and nothing it doesn't (what was discussed) — an invented summary
// in the mentee-visible history would be worse than an empty one.
const NOTE: Record<Locale, string> = {
  en: 'The scheduled meeting took place. Add what was discussed.',
  tr: 'Planlanan toplantı gerçekleşti. Görüşülenleri buraya ekleyebilirsiniz.',
  de: 'Das geplante Meeting hat stattgefunden. Ergänze, was besprochen wurde.',
};

function noteFor(preferredLanguage: string | null | undefined): string {
  return NOTE[isLocale(preferredLanguage ?? undefined) ? (preferredLanguage as Locale) : defaultLocale];
}

// What a loggable meeting looks like, whichever caller found it.
type LoggableMeeting = {
  id: string;
  title: string;
  scheduledAt: Date | null;
  relationId: string | null;
  relation: { mentor: { preferredLanguage: string | null } } | null;
};

const loggableSelect = {
  id: true,
  title: true,
  scheduledAt: true,
  relationId: true,
  relation: { select: { mentor: { select: { preferredLanguage: true } } } },
} as const;

/**
 * Write the interaction log for one meeting that took place. Returns true when
 * a row was created, false when there was nothing to write (not a relation
 * meeting, no start time, or already logged).
 */
export async function logMeetingInteraction(meeting: LoggableMeeting): Promise<boolean> {
  if (!meeting.relationId || !meeting.scheduledAt) return false;
  try {
    await prisma.interactionLog.create({
      data: {
        relationId: meeting.relationId,
        // The date of record is when the meeting was held, not when this ran:
        // the sweep may be up to a tick late, and a log dated "now" would sort
        // the history wrong.
        date: meeting.scheduledAt,
        subject: meeting.title.slice(0, TEXT_LIMITS.interactionSubject) || null,
        notes: noteFor(meeting.relation?.mentor.preferredLanguage),
        type: 'Meeting',
        autoLogged: true,
        meetingId: meeting.id,
      },
    });
    await dispatchWebhook('interaction.logged', {
      relationId: meeting.relationId,
      type: 'Meeting',
      date: meeting.scheduledAt.toISOString(),
      autoLogged: true,
    });
    return true;
  } catch (error) {
    // P2002 on the unique meetingId — the other path (click vs. sweep, or two
    // overlapping cron ticks) logged it first. That is the guard working, not
    // a failure.
    if (error && typeof error === 'object' && (error as { code?: string }).code === 'P2002') return false;
    throw error;
  }
}

/**
 * Log the meeting a participant just ended — and its siblings.
 *
 * A relation meeting writes one row per invited relation, all sharing the same
 * (per-event, unguessable) room link, and ending one ends them all. Each row
 * carries its own relation, so each one owes its own interaction log.
 */
export async function logEndedMeetingInteractions(meetingId: string): Promise<number> {
  const ended = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: { ...loggableSelect, meetLink: true },
  });
  if (!ended) return 0;

  const siblings = ended.meetLink && ended.scheduledAt
    ? await prisma.meeting.findMany({
        where: {
          meetLink: ended.meetLink,
          scheduledAt: ended.scheduledAt,
          relationId: { not: null },
          interaction: { is: null },
        },
        select: loggableSelect,
        take: SIBLING_BATCH,
      })
    : [ended];

  let logged = 0;
  for (const meeting of siblings) {
    if (await logMeetingInteraction(meeting)) logged++;
  }
  return logged;
}

/**
 * Catch meetings nobody marked as ended: anything inside the lookback window
 * that started more than the grace period ago and has no log yet.
 *
 * Declined invitations are skipped — an RSVP that says "I can't make it" is the
 * one signal available that the meeting did not happen for that pair, and a
 * false "you met" in a mentee's own history is worse than a missing one.
 */
export async function sweepMeetingInteractionLogs(now: Date = new Date()) {
  const cutoff = new Date(now.getTime() - MEETING_AUTOLOG_GRACE_MINUTES * 60 * 1000);
  const lookback = new Date(now.getTime() - SWEEP_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const meetings = await prisma.meeting.findMany({
    where: {
      relationId: { not: null },
      interaction: { is: null },
      rsvp: { not: 'DECLINED' },
      scheduledAt: { not: null, gte: lookback, lte: cutoff },
      // An explicitly ended meeting is logged on the click; it reaches the
      // sweep only when that write failed, which is exactly what a second
      // chance is for. Either way the meeting has to be old enough to be over.
    },
    select: loggableSelect,
    orderBy: { scheduledAt: 'desc' },
    take: SWEEP_BATCH,
  });

  let logged = 0;
  for (const meeting of meetings) {
    if (await logMeetingInteraction(meeting)) logged++;
  }
  return { scanned: meetings.length, logged };
}
