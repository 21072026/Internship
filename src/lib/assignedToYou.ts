import 'server-only';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { withinTenant, type TenantWhere } from '@/lib/tenantFilter';

// "Assigned to you" (#3874): the records that came to a rep from someone else —
// an admin's assignment or transfer (POST /api/mentorship, transferMentorship),
// a colleague's hand-off (which is a transfer) — and that the rep has not opened
// since. The sales home lists them on top, the board as a strip above its
// columns; opening the lead page marks the record seen (markAssignmentSeen).
//
// The rule, in one place:
//   - own (`mentorId = viewer`), ACTIVE, inside the viewer's tenant;
//   - `assignedAt` set and `assignmentSeenAt` null;
//   - `assignedById` set and not the viewer — a record you took yourself (a pool
//     claim, a lead you typed in, an admin assigning themself) is not news.
// Rows written before the columns existed have no `assignedAt`, so a rollout
// shows nobody an old book as "new".

/** Enough for a card; the count says how many there are in all. */
export const ASSIGNED_TO_YOU_LIMIT = 10;

export interface AssignedToYouItem {
  relationId: string;
  leadName: string;
  companyName: string | null;
  fromName: string | null;
  assignedAt: Date;
  nextActionAt: Date | null;
  nextActionNote: string | null;
}

function where(viewerId: string, tenant: TenantWhere): Prisma.MentorshipRelationWhereInput {
  return withinTenant<Prisma.MentorshipRelationWhereInput>(
    {
      mentorId: viewerId,
      status: 'ACTIVE',
      assignedAt: { not: null },
      assignmentSeenAt: null,
      assignedById: { not: null },
      NOT: { assignedById: viewerId },
    },
    tenant,
  );
}

export async function assignedToYou(
  viewerId: string,
  tenant: TenantWhere,
): Promise<{ items: AssignedToYouItem[]; total: number }> {
  const w = where(viewerId, tenant);
  const [rows, total] = await Promise.all([
    prisma.mentorshipRelation.findMany({
      where: w,
      orderBy: [{ assignedAt: 'desc' }, { id: 'asc' }],
      take: ASSIGNED_TO_YOU_LIMIT,
      select: {
        id: true,
        assignedAt: true,
        assignedById: true,
        nextActionAt: true,
        nextActionNote: true,
        mentee: { select: { fullName: true } },
        company: { select: { name: true } },
      },
    }),
    prisma.mentorshipRelation.count({ where: w }),
  ]);
  const byIds = [...new Set(rows.map((r) => r.assignedById).filter((x): x is string => !!x))];
  const people = byIds.length
    ? await prisma.user.findMany({ where: { id: { in: byIds } }, select: { id: true, fullName: true } })
    : [];
  const nameOf = new Map(people.map((p) => [p.id, p.fullName]));
  return {
    total,
    items: rows.map((r) => ({
      relationId: r.id,
      leadName: r.mentee.fullName,
      companyName: r.company?.name ?? null,
      fromName: (r.assignedById && nameOf.get(r.assignedById)) || null,
      assignedAt: r.assignedAt!,
      nextActionAt: r.nextActionAt,
      nextActionNote: r.nextActionNote,
    })),
  };
}

/**
 * The owner opened the record: it is no longer new. Only the owner's own view
 * counts — an admin or a colleague reading it does not clear the owner's card.
 * One conditional write, a no-op once seen.
 */
export async function markAssignmentSeen(relationId: string, viewerId: string): Promise<void> {
  await prisma.mentorshipRelation.updateMany({
    where: { id: relationId, mentorId: viewerId, assignedAt: { not: null }, assignmentSeenAt: null },
    data: { assignmentSeenAt: new Date() },
  });
}
