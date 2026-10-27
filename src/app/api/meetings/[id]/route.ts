import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { resolveOrgId } from '@/lib/orgScope';
import { withTenantScope } from '@/lib/orgContext';
import { enforceRateLimit } from '@/lib/rateLimit';
import { prisma } from '@/lib/prisma';
import { emit } from '@/lib/events/emit';
import { canManageMeeting, type MeetingUser } from '@/lib/meetingAccess';
import { isValidTimeZone, parseUserDateTime } from '@/lib/timezone';
import { pushMeetingInBackground, pushableSelect, withdrawMeetings } from '@/lib/googleCalendarSync';
import { durationMinutesField, meetingEnd } from '@/lib/meetingDuration';
import { conflictBody, findConflictFor, lockParticipants, recordForcedBooking, EXTERNAL_PAD_MS, type ExternalBusy } from '@/lib/busyWindows';
import { providerBusy } from '@/lib/calendarFreeBusy';
import type { BusyWindow } from '@/lib/busyWindowsRule';
import { findPolicyViolation, policyBody, policyExempt, recordPolicyOverride } from '@/lib/bookingPolicy';
import type { PolicyViolation } from '@/lib/bookingPolicyRule';
import { cancelMeetingRows } from '@/lib/meetingCancel';
import { noticeMeetingsCancelled, noticeMeetingsRescheduled } from '@/lib/meetingChangeNotices';

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
// admin. A MENTEE declines or counter-proposes from the RSVP page (#1982); a COMPANY
// or SOURCE session is refused by the same allowlist. Every refusal answers
// exactly like an unknown id, so the id space stays opaque.

/** How long a bulk schedule may be, so one `scope: 'batch'` can't walk a table. */
const MAX_BATCH_ROWS = 100;

// The calendar withdrawal (#1986) runs BEFORE the rows are deleted and is
// bounded — see `withdrawMeetings()` in src/lib/googleCalendarSync.ts.

const patchSchema = z
  .object({
    // A wall clock ("2026-09-20T16:30") or a zone-qualified instant. Never fed
    // to `new Date()` directly — see the parse below (#1061).
    scheduledAt: z.string().min(1).optional(),
    timeZone: z.string().max(80).optional(),
    title: z.string().min(1).optional(),
    meetLink: z.string().url().optional().or(z.literal('')),
    // A new length (#1984); the mirror is re-pushed with the new end.
    durationMinutes: durationMinutesField,
    // The only status this route writes. Un-cancelling is deliberately not a
    // verb: the invitees were told it is off, so "on again" is a new meeting.
    status: z.literal('CANCELLED').optional(),
    cancelReason: z.string().max(1000).optional(),
    // "this person" (default) vs "the whole session" — see `batchKey`.
    scope: z.enum(['one', 'batch']).optional(),
    // Move over a collision on purpose (#1995) — recorded in the audit log.
    force: z.boolean().optional(),
  })
  .strict();

// Everything the route needs about a row, in one shape both verbs read.
const targetSelect = {
  ...pushableSelect,
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
  durationMinutes: number | null;
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
function mayActOnBatch(user: MeetingUser, row: Target): boolean {
  return user.role === 'ADMIN' || row.createdById === user.id;
}

/**
 * Resolve the addressed meeting and the caller's right to change it.
 *
 * Returns a NextResponse when the answer is "no" — always the same 404 for an
 * unknown id and for a meeting that is not the caller's to touch.
 */
async function loadTarget(
  user: MeetingUser,
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
  const { scheduledAt, timeZone, title, meetLink, durationMinutes, status, cancelReason, scope, force } = parsed.data;
  if (!scheduledAt && title === undefined && meetLink === undefined && durationMinutes === undefined && !status) {
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
      // The status flip, the late-cancel record and the calendar withdrawal
      // are one path (src/lib/meetingCancel.ts), shared with the interview
      // request's cancel route (#1844).
      await cancelMeetingRows({ ids, actorId: session.user.id, reason: cancelReason ?? null, now, orgId: resolveOrgId(session), subjectId: row.id });
      await prisma.auditLog.create({
        data: {
          actorId: session.user.id,
          action: 'meeting.cancel',
          targetId: row.id,
          orgId: resolveOrgId(session),
          detail: JSON.stringify({
            title: row.title,
            scheduledAt: row.scheduledAt?.toISOString() ?? null,
            scope: scope ?? 'one',
            rows: ids.length,
            reason: cancelReason?.trim() || null,
          }),
        },
      });
      // `meeting.cancelled` is raised by cancelMeetingRows() itself (#1998).
      //
      // Everyone it affects is told, in-app and by mail, on their own clock
      // (#1982). Inline rather than after(): the rows are bounded by
      // MAX_BATCH_ROWS and the reads must run inside this tenant scope.
      await noticeMeetingsCancelled(ids, session.user.id, cancelReason ?? null);
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

    // A new time or a new length must not land on top of something the pair
    // already has (#1995). The rows being moved are excluded — a meeting does not
    // collide with its own old slot — and so is the rest of the same session.
    const retimed = when !== null || durationMinutes !== undefined;
    // Booking over a collision is the admin's or the pair's own mentor's call.
    if (force && session.user.role !== 'ADMIN' && !targets.every((t) => t.relation?.mentorId === session.user.id)) {
      return NextResponse.json({ error: 'Only an admin or the mentor may book over a conflict' }, { status: 403 });
    }
    const pairs = retimed ? targets.flatMap((t) => (t.relation ? [t.relation.mentorId, t.relation.menteeId] : [])) : [];
    // The pairs' real calendars (#1997), fetched before the lock is taken.
    let external: ExternalBusy = new Map();
    if (pairs.length > 0) {
      const starts = targets.map((t) => (when ?? t.scheduledAt)?.getTime()).filter((x): x is number => x != null);
      if (starts.length) {
        const longest = Math.max(...targets.map((t) => (durationMinutes ?? t.durationMinutes ?? 60) * 60_000));
        external = await providerBusy(pairs, new Date(Math.min(...starts) - EXTERNAL_PAD_MS), new Date(Math.max(...starts) + longest + EXTERNAL_PAD_MS));
      }
    }
    const outcome = await prisma.$transaction(
      async (tx) => {
        let forcedOver: BusyWindow | null = null;
        let forcedRule: PolicyViolation | null = null;
        if (pairs.length > 0) {
          await lockParticipants(tx, pairs);
          const ruled = new Set<string>();
          for (const t of targets) {
            const start = when ?? t.scheduledAt;
            if (!start || !t.relation) continue;
            const window = { start, end: meetingEnd(start, { durationMinutes: durationMinutes ?? t.durationMinutes }) };
            const conflict = await findConflictFor(tx, session.user, [t.relation.mentorId, t.relation.menteeId], window, {
              excludeMeetingIds: ids,
              excludeBatchKey: row.batchKey ?? undefined,
              external,
            });
            if (conflict && !force) return { conflict };
            forcedOver ??= conflict;
            // The mentor's booking rules (#2003), once per mentor: a whole
            // session moved is one booking for them, not one per row.
            if (ruled.has(t.relation.mentorId) || policyExempt(session.user, t.relation.mentorId)) continue;
            ruled.add(t.relation.mentorId);
            const violation = await findPolicyViolation(tx, { mentorId: t.relation.mentorId, start: window.start, end: window.end, excludeMeetingIds: ids, excludeBatchKey: row.batchKey ?? undefined, external });
            if (violation && !force) return { policy: violation };
            forcedRule ??= violation;
          }
        }
        const moved: Target[] = [];
        const retimedIds: string[] = [];
        for (const t of targets) {
          const timeChanged = when !== null && t.scheduledAt?.getTime() !== when.getTime();
          if (timeChanged) retimedIds.push(t.id);
          const updated = (await tx.meeting.update({
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
              ...(durationMinutes !== undefined ? { durationMinutes } : {}),
              ...(when && zone ? { timeZone: zone } : {}),
            },
            select: targetSelect,
          })) as Target;
          moved.push(updated);
        }
        // A guest's answer was to the old time too (#1982): the move mail asks
        // them again, so their RSVP goes back to PENDING with the row's.
        if (retimedIds.length > 0) {
          await tx.meetingGuest.updateMany({ where: { meetingId: { in: retimedIds } }, data: { rsvp: 'PENDING', respondedAt: null } });
        }
        return { moved, retimedIds, forcedOver, forcedRule };
      },
      // A whole session is up to MAX_BATCH_ROWS rows, each checked and written.
      { timeout: 30_000 },
    );
    if (outcome.conflict) return NextResponse.json(conflictBody(outcome.conflict), { status: 409 });
    if (outcome.policy) return NextResponse.json(policyBody(outcome.policy), { status: 409 });
    const { moved, retimedIds, forcedOver, forcedRule } = outcome;
    if (forcedOver) await recordForcedBooking(session.user.id, row.id, forcedOver);
    if (forcedRule) await recordPolicyOverride(session.user.id, row.id, forcedRule);
    // The mirror follows the meeting. An existing GoogleCalendarEventLink
    // makes this a PATCH of the event that is already on their calendar
    // rather than a second one appearing next to the stale first.
    for (const updated of moved) pushMeetingInBackground(updated, mirrorAudience(updated));

    // One `meeting.rescheduled` per row whose TIME moved (#1998) — a new title
    // or link is not a reschedule, the same line the notices draw below.
    const retimedSet = new Set(retimedIds);
    for (const m of moved) {
      if (!retimedSet.has(m.id) || !m.scheduledAt) continue;
      const before = targets.find((t) => t.id === m.id)?.scheduledAt ?? null;
      await emit(
        'meeting.rescheduled',
        { meetingId: m.id, scheduledAt: m.scheduledAt.toISOString(), previousScheduledAt: before?.toISOString() ?? null },
        { orgId: resolveOrgId(session), actor: { id: session.user.id, type: 'user' } },
      );
    }

    // Told on their own clock — only when the TIME moved; a new title or room
    // link is not a reschedule (#1982).
    await noticeMeetingsRescheduled(retimedIds, session.user.id);

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
        durationMinutes: head.durationMinutes,
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
    await withdrawMeetings(ids);
    const removed = await prisma.meeting.deleteMany({ where: { id: { in: ids } } });
    // Deleting a meeting that was still on is calling it off, from where a
    // receiver stands (#1998); deleting an already-cancelled one is tidying up
    // and was announced when it was cancelled.
    const stillOn = targets.filter((t) => t.status === 'SCHEDULED');
    if (stillOn.length > 0) {
      const subject = stillOn.find((t) => t.id === row.id) ?? stillOn[0];
      await emit(
        'meeting.cancelled',
        { meetingId: subject.id, scheduledAt: subject.scheduledAt?.toISOString() ?? null, count: stillOn.length },
        { orgId: resolveOrgId(session), actor: { id: session.user.id, type: 'user' } },
      );
    }
    await prisma.auditLog.create({
      data: {
        actorId: session.user.id,
        action: 'meeting.delete',
        targetId: row.id,
        orgId: resolveOrgId(session),
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
