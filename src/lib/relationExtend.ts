// Extending a pairing's agreed end date (#1786) — the ONE writer of an
// extension. Server-only. Callers: POST /api/mentorship/[id]/extend (ADMIN or
// the relation's mentor, checked there) and the signed one-click link in the
// ending-soon mail (src/app/api/email-action/route.ts).
//
// What an extension does, in one guarded transaction:
//   · moves `expectedEndDate` later — never earlier, never into the past;
//   · counts it (`durationExtendedCount` + 1) — an edit of the date through
//     PUT /api/mentorship/[id] is a correction and is not counted;
//   · clears `endingSoonNotifiedAt`, so the NEW end date gets its own single
//     ending-soon nudge (src/lib/relationEnding.ts);
//   · writes a RelationLifecycleEvent with toState = fromState and reason
//     EXTENDED_REASON_CODE, so the audit trail shows it beside pauses and ends.
// After the commit: the `mentorship.extended` event and an in-app notice to
// the other participant(s). It never changes the pairing's state.
//
// RACES AND REPLAYS. The update is guarded on the end date the caller read
// (`expectedEndDate` in the WHERE), so two clicks cannot extend twice — the
// second finds the date already moved and answers 409. The mail link carries
// the end date it was minted for (`expectFromDay`) for the same reason: once
// used, or once anybody changed the date, the link is spent.

import { prisma } from '@/lib/prisma';
import { emit } from '@/lib/events/emit';
import { notifyIfAllowed } from '@/lib/notify';
import { addMonthsUtc, parseEndDate } from '@/lib/relationSchedule';
import { MAX_EXTEND_MONTHS, originalDurationMonths } from '@/lib/relationEnding';
import { EXTENDED_REASON_CODE, effectiveLifecycleState } from '@/lib/relationLifecycle';

export type ExtendRefusal = 'not_found' | 'not_live' | 'no_end_date' | 'not_later' | 'stale' | 'conflict' | 'invalid';

export type ExtendResult =
  | { ok: true; expectedEndDate: string; durationExtendedCount: number }
  | { ok: false; status: 400 | 404 | 409; code: ExtendRefusal };

const day = (d: Date) => d.toISOString().slice(0, 10);

export async function extendRelation(input: {
  relationId: string;
  actorId: string;
  /** Extend by this many months from the current end date. */
  months?: number;
  /** …or to this calendar day. Neither → by the pairing's original length. */
  until?: string;
  note?: string | null;
  /** The end date the caller saw (the mail link's); a different one is `stale`. */
  expectFromDay?: string;
}): Promise<ExtendResult> {
  const relation = await prisma.mentorshipRelation.findUnique({
    where: { id: input.relationId },
    select: {
      id: true,
      orgId: true,
      status: true,
      lifecycleState: true,
      startDate: true,
      expectedEndDate: true,
      durationExtendedCount: true,
      mentorId: true,
      menteeId: true,
      mentor: { select: { fullName: true } },
      mentee: { select: { fullName: true } },
    },
  });
  if (!relation) return { ok: false, status: 404, code: 'not_found' };
  // A live pairing only (a paused one is still live: status ACTIVE).
  if (relation.status !== 'ACTIVE') return { ok: false, status: 409, code: 'not_live' };
  const current = relation.expectedEndDate;
  if (input.expectFromDay !== undefined && (current ? day(current) : '') !== input.expectFromDay) {
    return { ok: false, status: 409, code: 'stale' };
  }

  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let next: Date | null;
  if (input.until !== undefined) {
    next = parseEndDate(input.until);
    if (!next) return { ok: false, status: 400, code: 'invalid' };
  } else {
    if (!current && input.months === undefined) return { ok: false, status: 400, code: 'no_end_date' };
    const months = input.months ?? originalDurationMonths(relation.startDate, current!);
    if (!Number.isInteger(months) || months < 1 || months > MAX_EXTEND_MONTHS) return { ok: false, status: 400, code: 'invalid' };
    // An end date already in the past extends from today, not from the past.
    const from = current && current > today ? current : today;
    next = addMonthsUtc(from, months);
  }
  if (next <= today || (current && next <= current)) return { ok: false, status: 400, code: 'not_later' };

  const state = effectiveLifecycleState(relation);
  const extendedTo = next;
  const moved = await prisma.$transaction(async (tx) => {
    const res = await tx.mentorshipRelation.updateMany({
      where: { id: relation.id, status: 'ACTIVE', expectedEndDate: current },
      data: { expectedEndDate: extendedTo, durationExtendedCount: { increment: 1 }, endingSoonNotifiedAt: null },
    });
    if (res.count !== 1) return false;
    await tx.relationLifecycleEvent.create({
      data: {
        relationId: relation.id,
        fromState: state,
        toState: state,
        reasonCode: EXTENDED_REASON_CODE,
        reasonNote: input.note?.trim() || null,
        changedById: input.actorId,
      },
    });
    return true;
  });
  if (!moved) return { ok: false, status: 409, code: 'conflict' };

  const count = relation.durationExtendedCount + 1;
  await emit(
    'mentorship.extended',
    { relationId: relation.id, expectedEndDate: day(extendedTo), extendedCount: count },
    { orgId: relation.orgId, actor: { id: input.actorId, type: 'user' } },
  );
  // The mentee always hears about it; the mentor too when an admin extended it.
  await notifyIfAllowed(relation.menteeId, 'mentorship', 'mentorship.extended', { name: relation.mentor.fullName, date: day(extendedTo) }, '/portal');
  if (input.actorId !== relation.mentorId) {
    await notifyIfAllowed(relation.mentorId, 'mentorship', 'mentorship.extended', { name: relation.mentee.fullName, date: day(extendedTo) }, `/mentor/mentees/${relation.id}`);
  }
  return { ok: true, expectedEndDate: day(extendedTo), durationExtendedCount: count };
}
