import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { enforceRateLimit } from '@/lib/rateLimit';
import { prisma } from '@/lib/prisma';
import { canManageMeeting } from '@/lib/meetingAccess';
import { isValidTimeZone, parseUserDateTime } from '@/lib/timezone';
import { pushMeetingInBackground, removeMeeting } from '@/lib/googleCalendarSync';
import { dispatchWebhook } from '@/lib/webhooks';

// The three verbs a meeting never had (#1980).
//
// Until now the only way to fix a wrong time was to schedule a second meeting
// and abandon the first — which stayed on the dashboard, in the reminder queue,
// in the .ics feed and on the participant's real Google Calendar forever.
//
//   PATCH  — move it (time / clock / title / room link), or call it off
//            (`status: 'CANCELLED'`, with a reason).
//   DELETE — remove the row outright. What was *written* in the meeting
//            survives: PersonalNote.meetingId and InteractionLog.meetingId are
//            `onDelete: SetNull` on purpose (prisma/schema.prisma).
//
// Cancelling is the softer verb and the one to reach for: the row stays, so the
// notes, the log and "there was a meeting here and it was called off" stay too.
// Deleting is for a meeting that should never have existed.
//
// Authorization is decided HERE, server-side, by `canManageMeeting` — being in
// a meeting is not being in charge of it. Organiser, the relation's mentor, and
// admin. A MENTEE declines (and, once #1982 lands, counter-proposes); a COMPANY
// or SOURCE session is refused by the same allowlist. Every refusal answers
// exactly like an unknown id, so the id space stays opaque.

/** How long a bulk schedule may be, so one `scope: 'batch'` can't walk a table. */
const MAX_BATCH_ROWS = 100;

/**
 * Ceiling on the calendar withdrawal before the request answers anyway.
 *
 * `removeMeeting` has to run BEFORE the rows are deleted — `GoogleCalendarEventLink`
 * cascades away with the meeting, and a withdrawal with no links left to read is
 * a no-op that leaves a ghost event on someone's real calendar. So this one is
 * awaited rather than fired and forgotten, and bounded instead: a third party's
 * API may not make cancelling or deleting a meeting hang. It is a no-op (and
 * returns immediately) unless the integration is switched on and the person
 * connected their own account.
 */
const CALENDAR_WITHDRAW_MS = 5_000;

const patchSchema = z
  .object({
    // A wall clock ("2026-09-20T16:30") or a zone-qualified instant. Never fed
    // to `new Date()` directly — see the parse below (#1061).
    scheduledAt: z.string().min(1).optional(),
    timeZone: z.string().max(80).optional(),
    title: z.string().min(1).optional(),
    meetLink: z.string().url().optional().or(z.literal('')),
    // The only status this route writes. Un-cancelling is deliberately not a
    // verb: the invitees were told it is off, so "on again" is a new meeting.
    status: z.literal('CANCELLED').optional(),
    cancelReason: z.string().max(1000).optional(),
    // "this person" (default) vs "the whole session" — see `batchKey`.
    scope: z.enum(['one', 'batch']).optional(),
  })
  .strict();

// Everything the route needs about a row, in one shape both verbs read.
const targetSelect = {
  id: true,
  title: true,
  scheduledAt: true,
  timeZone: true,
  meetLink: true,
  status: true,
  endedAt: true,
  batchKey: true,
  createdById: true,
  relationId: true,
  relation: { select: { mentorId: true, menteeId: true } },
} as const;

type Target = {
  id: string;
  title: string;
  scheduledAt: Date | null;
  timeZone: string | null;
  meetLink: string | null;
  status: string;
  endedAt: Date | null;
  batchKey: string | null;
  createdById: string;
  relationId: string | null;
  relation: { mentorId: string; menteeId: string } | null;
};

const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404 });

function readId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    /* keep the raw segment — a lone % is not worth a 500 */
    return raw;
  }
}

/** Everyone whose own calendar may hold a mirror of this row. */
function mirrorAudience(t: Target): string[] {
  return [t.createdById, t.relation?.mentorId, t.relation?.menteeId].filter((x): x is string => Boolean(x));
}

/**
 * Drop the meeting from every calendar it was mirrored to, bounded by
 * CALENDAR_WITHDRAW_MS. Never rejects: the meeting is being cancelled or
 * deleted here either way, and a calendar that would not answer must not turn
 * that into a 500.
 */
async function withdrawFromCalendars(ids: string[]): Promise<void> {
  const work = Promise.allSettled(ids.map((id) => removeMeeting(id)));
  await Promise.race([work, new Promise<void>((resolve) => setTimeout(resolve, CALENDAR_WITHDRAW_MS))]);
}

/**
 * The rows this call acts on: just the addressed one, or — with
 * `scope: 'batch'` — every row of the same bulk schedule.
 *
 * A null `batchKey` means "just this row", never "all the rows with no batch":
 * every meeting written before #1980 has a null key, and grouping those would
 * make one cancel take out unrelated meetings.
 */
async function resolveTargets(
  row: Target,
  scope: 'one' | 'batch' | undefined,
  // A move may only touch rows that are still on; a delete may also clear the
  // ones already called off (that is how a cancelled batch is tidied away).
  opts: { scheduledOnly: boolean }
): Promise<Target[]> {
  if (scope !== 'batch' || !row.batchKey) return [row];
  const siblings = await prisma.meeting.findMany({
    where: {
      batchKey: row.batchKey,
      endedAt: null,
      ...(opts.scheduledOnly ? { status: 'SCHEDULED' as const } : {}),
    },
    select: targetSelect,
    take: MAX_BATCH_ROWS,
  });
  return siblings.length > 0 ? (siblings as Target[]) : [row];
}

/**
 * May this caller act on the WHOLE bulk schedule, not just the addressed row?
 *
 * A batch fans out over several relations, so a mentor who manages one row of it
 * is not thereby in charge of the others — that is somebody else's pair. The
 * session as a whole belongs to the person who called it, and to an admin.
 * Refused with a 403, not the opaque 404: the caller can already see this
 * meeting, so there is nothing left to hide, and "you may change your row, not
 * everyone's" is the only answer that says what to do instead.
 */
function mayActOnBatch(user: { id: string; role: string }, row: Target): boolean {
  return user.role === 'ADMIN' || row.createdById === user.id;
}

/**
 * Resolve the addressed meeting and the caller's right to change it.
 *
 * Returns a NextResponse when the answer is "no" — always the same 404 for an
 * unknown id and for a meeting that is not the caller's to touch.
 */
async function loadTarget(
  user: { id: string; role: string },
  id: string
): Promise<{ row: Target } | { refuse: NextResponse }> {
  // `<seriesId>:<ISO instant>` — the shape /api/meetings/upcoming hands out for
  // a recurring occurrence the banner synthesized. There is no row to move or
  // delete; changing a recurring call means changing its rule.
  if (id.includes(':')) return { refuse: notFound() };
  if (!(await canManageMeeting(user, id))) return { refuse: notFound() };
  const row = (await prisma.meeting.findUnique({ where: { id }, select: targetSelect })) as Target | null;
  if (!row) return { refuse: notFound() };
  return { row };
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const limited = enforceRateLimit(request, 'meeting-mutate', { limit: 20, windowMs: 60_000 });
  if (limited) return limited;

  const { id: rawId } = await params;
  const id = readId(rawId);
  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  }
  const { scheduledAt, timeZone, title, meetLink, status, cancelReason, scope } = parsed.data;
  if (!scheduledAt && title === undefined && meetLink === undefined && !status) {
    return NextResponse.json({ error: 'Validation failed', details: { body: 'Nothing to change' } }, { status: 400 });
  }

  return await withTenantScope(session, async () => {
    const found = await loadTarget(session.user, id);
    if ('refuse' in found) return found.refuse;
    const { row } = found;

    // A meeting that already happened is a record, not a plan.
    if (row.endedAt) return NextResponse.json({ error: 'Meeting has already ended' }, { status: 410 });
    if (row.status === 'CANCELLED') return NextResponse.json({ error: 'Meeting is cancelled' }, { status: 409 });

    if (scope === 'batch' && !mayActOnBatch(session.user, row)) {
      return NextResponse.json({ error: 'Only the organiser may act on the whole session' }, { status: 403 });
    }
    const targets = await resolveTargets(row, scope, { scheduledOnly: true });
    const ids = targets.map((t) => t.id);
    const now = new Date();

    if (status === 'CANCELLED') {
      await prisma.meeting.updateMany({
        where: { id: { in: ids } },
        data: {
          status: 'CANCELLED',
          cancelledAt: now,
          cancelledById: session.user.id,
          cancelReason: cancelReason?.trim() || null,
        },
      });
      // Off the invitees' real calendars too — through the helper, never by
      // deleting GoogleCalendarEventLink rows from here (#1986 owns that file).
      await withdrawFromCalendars(ids);
      await prisma.auditLog.create({
        data: {
          actorId: session.user.id,
          action: 'meeting.cancel',
          targetId: row.id,
          detail: JSON.stringify({
            title: row.title,
            scheduledAt: row.scheduledAt?.toISOString() ?? null,
            scope: scope ?? 'one',
            rows: ids.length,
            reason: cancelReason?.trim() || null,
          }),
        },
      });
      await dispatchWebhook('meeting.cancelled', {
        id: row.id,
        title: row.title,
        scheduledAt: row.scheduledAt ? row.scheduledAt.toISOString() : null,
        reason: cancelReason?.trim() || null,
        count: ids.length,
      });
      // Telling the participants is #1982's half of this story; the state and
      // the calendar are this one's.
      return NextResponse.json({ ok: true, status: 'CANCELLED', changed: ids.length });
    }

    // ---- a move -----------------------------------------------------------
    let when: Date | null = null;
    let zone: string | null = null;
    if (scheduledAt) {
      const actor = await prisma.user.findUnique({
        where: { id: session.user.id },
        select: { timezone: true },
      });
      // A bare wall clock must be anchored to the actor's own zone; `new Date()`
      // would read it in the container's (UTC) and silently shift the meeting by
      // their offset (#1061).
      when = parseUserDateTime(scheduledAt, actor?.timezone);
      if (!when) {
        return NextResponse.json(
          { error: 'Validation failed', details: { scheduledAt: 'Invalid date/time' } },
          { status: 400 }
        );
      }
      // The clock the new time was picked on. An unusable zone falls back to the
      // actor's saved one and then to whatever the row already carried, exactly
      // as POST /api/meetings does.
      zone = isValidTimeZone(timeZone) ? timeZone : isValidTimeZone(actor?.timezone) ? actor.timezone : null;
    }

    const moved: Target[] = [];
    for (const t of targets) {
      const timeChanged = when !== null && t.scheduledAt?.getTime() !== when.getTime();
      const updated = (await prisma.meeting.update({
        where: { id: t.id },
        data: {
          ...(when ? { scheduledAt: when } : {}),
          ...(timeChanged
            ? {
                previousScheduledAt: t.scheduledAt,
                rescheduledAt: now,
                // Or the reminder for the new time never fires: the cron claims
                // a meeting by stamping this, and only ever looks at nulls.
                reminderSentAt: null,
                // An answer given to the old time is not an answer to this one.
                // The mentee said yes to Tuesday 10:00, not to Thursday 15:00.
                rsvp: 'PENDING' as const,
              }
            : {}),
          ...(title !== undefined ? { title } : {}),
          ...(meetLink !== undefined ? { meetLink: meetLink || null } : {}),
          ...(when && zone ? { timeZone: zone } : {}),
        },
        select: targetSelect,
      })) as Target;
      moved.push(updated);
      // The mirror follows the meeting. An existing GoogleCalendarEventLink
      // makes this a PATCH of the event that is already on their calendar
      // rather than a second one appearing next to the stale first.
      pushMeetingInBackground(updated, mirrorAudience(updated));
    }

    if (when) {
      await dispatchWebhook('meeting.rescheduled', {
        id: row.id,
        title: moved[0]?.title ?? row.title,
        previousScheduledAt: row.scheduledAt ? row.scheduledAt.toISOString() : null,
        scheduledAt: when.toISOString(),
        count: moved.length,
      });
    }

    const head = moved[0] ?? row;
    return NextResponse.json({
      ok: true,
      changed: moved.length,
      meeting: {
        id: head.id,
        title: head.title,
        scheduledAt: head.scheduledAt,
        timeZone: head.timeZone,
        meetLink: head.meetLink,
        status: head.status,
      },
    });
  });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const limited = enforceRateLimit(request, 'meeting-mutate', { limit: 20, windowMs: 60_000 });
  if (limited) return limited;

  const { id: rawId } = await params;
  const id = readId(rawId);
  const url = new URL(request.url);
  const scopeParam = url.searchParams.get('scope');
  if (scopeParam && scopeParam !== 'one' && scopeParam !== 'batch') {
    return NextResponse.json({ error: 'Validation failed', details: { scope: 'Unknown scope' } }, { status: 400 });
  }

  return await withTenantScope(session, async () => {
    const found = await loadTarget(session.user, id);
    if ('refuse' in found) return found.refuse;
    const { row } = found;

    // A meeting that was held is part of the record — the interaction log
    // written from it points at this row. Cancel it or leave it; do not erase
    // what happened. A CANCELLED meeting, by contrast, IS deletable: that is
    // the only way a row called off by mistake ever leaves the list.
    if (row.endedAt) return NextResponse.json({ error: 'Meeting has already ended' }, { status: 410 });

    if (scopeParam === 'batch' && !mayActOnBatch(session.user, row)) {
      return NextResponse.json({ error: 'Only the organiser may act on the whole session' }, { status: 403 });
    }
    const targets = await resolveTargets(row, scopeParam === 'batch' ? 'batch' : 'one', { scheduledOnly: false });
    const ids = targets.map((t) => t.id);

    // Before the delete, not after: the link rows cascade away with the meeting,
    // and a withdrawal with nothing left to read leaves a ghost event behind.
    await withdrawFromCalendars(ids);
    const removed = await prisma.meeting.deleteMany({ where: { id: { in: ids } } });
    await prisma.auditLog.create({
      data: {
        actorId: session.user.id,
        action: 'meeting.delete',
        targetId: row.id,
        detail: JSON.stringify({
          title: row.title,
          scheduledAt: row.scheduledAt?.toISOString() ?? null,
          scope: scopeParam === 'batch' ? 'batch' : 'one',
          rows: removed.count,
        }),
      },
    });
    return NextResponse.json({ ok: true, deleted: removed.count });
  });
}
