// The only writer and reader of FollowUpEvent (#3819). The rule — which event
// an edit makes and its dedupe key — is src/lib/followUpEventRule.ts.
//
// The writer returns a Prisma operation instead of running it, so the caller
// puts it in the SAME transaction as the follow-up columns: a record whose
// follow-up moved always has its line, and a line never describes a write
// that rolled back. `createMany({ skipDuplicates })` is the dedupe — on MySQL
// an INSERT IGNORE against the unique (relationId, dedupeKey), so the racing
// copy of a request neither writes a second row nor fails the transaction.
import { prisma } from '@/lib/prisma';
import {
  followUpDedupeKey,
  isFollowUpEventKind,
  type FollowUpEventFacts,
  type FollowUpEventKind,
} from '@/lib/followUpEventRule';

export function followUpEventWrite(opts: {
  relationId: string;
  facts: FollowUpEventFacts;
  /** The record's updatedAt as read BEFORE this write. */
  recordUpdatedAt: Date;
  actorId: string | null;
  owners?: { from?: string | null; to?: string | null };
}) {
  const { relationId, facts, recordUpdatedAt, actorId, owners } = opts;
  return prisma.followUpEvent.createMany({
    data: [
      {
        relationId,
        kind: facts.kind,
        fromAt: facts.fromAt,
        toAt: facts.toAt,
        fromNote: facts.fromNote,
        toNote: facts.toNote,
        fromUserId: owners?.from ?? null,
        toUserId: owners?.to ?? null,
        actorId,
        dedupeKey: followUpDedupeKey(facts, recordUpdatedAt, owners),
      },
    ],
    skipDuplicates: true,
  });
}

export interface FollowUpEventView {
  id: string;
  kind: FollowUpEventKind;
  createdAt: Date;
  fromAt: Date | null;
  toAt: Date | null;
  fromNote: string | null;
  toNote: string | null;
  actorName: string | null;
  fromName: string | null;
  toName: string | null;
}

/** Bounded like the interaction list beside it. */
export const FOLLOW_UP_EVENTS_LIMIT = 50;

/**
 * A record's follow-up events, newest first, with the names the history line
 * needs. The caller has already decided the viewer may read the record AND
 * its follow-up (canSeeNextAction) — the notes are the owner's working prose.
 */
export async function followUpEventsFor(relationId: string): Promise<FollowUpEventView[]> {
  const rows = await prisma.followUpEvent.findMany({
    where: { relationId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: FOLLOW_UP_EVENTS_LIMIT,
    select: {
      id: true,
      kind: true,
      createdAt: true,
      fromAt: true,
      toAt: true,
      fromNote: true,
      toNote: true,
      fromUserId: true,
      toUserId: true,
      actor: { select: { fullName: true } },
    },
  });
  const ownerIds = [...new Set(rows.flatMap((r) => [r.fromUserId, r.toUserId]).filter((x): x is string => !!x))];
  const owners = ownerIds.length
    ? await prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, fullName: true } })
    : [];
  const nameOf = new Map(owners.map((u) => [u.id, u.fullName]));
  return rows
    .filter((r) => isFollowUpEventKind(r.kind))
    .map((r) => ({
      id: r.id,
      kind: r.kind as FollowUpEventKind,
      createdAt: r.createdAt,
      fromAt: r.fromAt,
      toAt: r.toAt,
      fromNote: r.fromNote,
      toNote: r.toNote,
      actorName: r.actor?.fullName ?? null,
      fromName: r.fromUserId ? nameOf.get(r.fromUserId) ?? null : null,
      toName: r.toUserId ? nameOf.get(r.toUserId) ?? null : null,
    }));
}
