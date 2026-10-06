// Who may WRITE a mentor's hours and away windows, and the overlap rule they
// are written against (#2001). Server-only.
//
// AvailabilitySlot and AvailabilityException carry no orgId and are not in
// TENANT_MODELS, so the central isolation middleware never sees them; the row
// is reached through `mentorId → User`, and this file makes that hop explicit —
// the same missing hop that let an admin delete another tenant's slot (#1350).
//
// The rule: the mentor themselves, or an ADMIN acting for a user of their OWN
// organization. Nobody else — a mentee reads, never writes.

import type { Session } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { resolveTimeZone } from '@/lib/timezone';
import { dateInZone } from '@/lib/availabilitySlots';

/** May this caller write availability rows that belong to `ownerId`? */
export async function mayWriteAvailabilityFor(session: Session, ownerId: string): Promise<boolean> {
  if (ownerId === session.user.id) return session.user.role === 'MENTOR' || session.user.role === 'ADMIN';
  if (session.user.role !== 'ADMIN') return false;
  const sameOrg = await withTenantScope(session, () =>
    prisma.user.findFirst({ where: { id: ownerId, orgId: resolveOrgId(session) }, select: { id: true } })
  );
  return !!sameOrg;
}

/**
 * The mentor a create call writes for: the caller, or — for an ADMIN who names
 * one — that mentor, once the org check passes. Null means refuse.
 */
export async function writableMentorId(session: Session, requested: string | null | undefined): Promise<string | null> {
  const target = requested || session.user.id;
  return (await mayWriteAvailabilityFor(session, target)) ? target : null;
}

/**
 * Today's date in the mentor's zone, as a `@db.Date` value. A one-off or an
 * away window that ended before it is history: it is filtered out of reads
 * rather than swept, so there is no cron to forget and nothing is deleted.
 */
export function mentorToday(timezone: string | null | undefined, now = new Date()): Date {
  return new Date(`${dateInZone(now, resolveTimeZone(timezone))}T00:00:00Z`);
}

/** The rows a read should return: weekly ones, and dated ones not yet past. */
export function liveSlotsWhere(mentorId: string, today: Date) {
  return { mentorId, OR: [{ date: null }, { date: { gte: today } }] };
}

/**
 * The slot a new or edited interval collides with, or null. Half-open on
 * zero-padded "HH:MM" strings, exactly as #1363 defined it — string order is
 * chronological order, so the database does the comparison.
 *
 * A weekly slot competes with the weekly slots of its weekday and with the
 * live one-offs that fall on that weekday; a one-off competes with the weekly
 * pattern of its weekday and with the one-offs of its own date. Either way two
 * rows would otherwise offer the same hour twice.
 */
export async function findSlotClash(
  mentorId: string,
  slot: { weekday: number; date: Date | null; startTime: string; endTime: string },
  opts: { excludeId?: string; today: Date }
) {
  return prisma.availabilitySlot.findFirst({
    where: {
      mentorId,
      startTime: { lt: slot.endTime },
      endTime: { gt: slot.startTime },
      ...(opts.excludeId ? { id: { not: opts.excludeId } } : {}),
      OR: slot.date
        ? [{ date: null, weekday: slot.weekday }, { date: slot.date }]
        : [{ date: null, weekday: slot.weekday }, { weekday: slot.weekday, date: { gte: opts.today } }],
    },
    select: { startTime: true, endTime: true, date: true },
  });
}
