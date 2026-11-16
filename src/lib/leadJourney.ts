import 'server-only';
import { prisma } from '@/lib/prisma';

// A lead's journey across hand-offs (#3817). A hand-off (src/lib/leadHandoff.ts
// → transferMentorship()) closes the record as ENDED_REASSIGNED and opens a new
// one carrying `previousRelationId`; nothing is moved between the two
// (docs/mentor-transfer.md). So the lead page reads the chain instead:
//
// - backwards from the record it shows, the earlier owners' periods and the
//   interactions logged in them — shown as their own, collapsed section, so the
//   work stays with the period (and the person) it was written in;
// - forwards from a closed record, the record that carries the lead now — so an
//   old link opens a banner pointing there rather than a second copy of the lead.
//
// Only reading. Every link must be the same lead (menteeId) in the same org as
// the record the viewer was already allowed to open, and the walk is capped and
// cycle-safe: a chain is short (one link per hand-off), and a bad row must not
// turn into a loop or a read of somebody else's record.

const MAX_HOPS = 20;
const PERIOD_INTERACTION_LIMIT = 50;

type Anchor = { id: string; orgId: string | null; menteeId: string; previousRelationId: string | null };

export interface EarlierPeriod {
  relationId: string;
  ownerName: string;
  from: Date;
  /** When the period ended (the hand-off); null for a row closed before completedAt was stamped. */
  to: Date | null;
  interactions: { id: string; date: Date; type: string; subject: string | null; notes: string }[];
}

/** The earlier owners' periods of this lead, newest first, each with its interactions. */
export async function earlierPeriods(anchor: Anchor): Promise<EarlierPeriod[]> {
  const chain: { id: string; ownerName: string; from: Date; to: Date | null }[] = [];
  const seen = new Set<string>([anchor.id]);
  let nextId = anchor.previousRelationId;
  while (nextId && !seen.has(nextId) && chain.length < MAX_HOPS) {
    seen.add(nextId);
    const link = await prisma.mentorshipRelation.findFirst({
      where: { id: nextId, orgId: anchor.orgId, menteeId: anchor.menteeId },
      select: { id: true, startDate: true, completedAt: true, previousRelationId: true, mentor: { select: { fullName: true } } },
    });
    if (!link) break;
    chain.push({ id: link.id, ownerName: link.mentor.fullName, from: link.startDate, to: link.completedAt });
    nextId = link.previousRelationId;
  }
  if (chain.length === 0) return [];

  const logs = await prisma.interactionLog.findMany({
    where: { relationId: { in: chain.map((c) => c.id) } },
    orderBy: { date: 'desc' },
    take: PERIOD_INTERACTION_LIMIT * chain.length,
    select: { id: true, relationId: true, date: true, type: true, subject: true, notes: true },
  });
  return chain.map((c) => ({
    relationId: c.id,
    ownerName: c.ownerName,
    from: c.from,
    to: c.to,
    interactions: logs
      .filter((l) => l.relationId === c.id)
      .slice(0, PERIOD_INTERACTION_LIMIT)
      .map(({ relationId: _relationId, ...rest }) => rest),
  }));
}

/**
 * The record that carries this lead now, when this one was handed on: the tip of
 * the chain forward (a lead handed on twice points at the second successor).
 * Null for a record that was never handed on.
 */
export async function currentSuccessor(anchor: Pick<Anchor, 'id' | 'orgId' | 'menteeId'>): Promise<{
  relationId: string;
  ownerName: string;
  since: Date;
} | null> {
  let tip: { id: string; ownerName: string; since: Date } | null = null;
  const seen = new Set<string>([anchor.id]);
  let fromId = anchor.id;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const next = await prisma.mentorshipRelation.findFirst({
      where: { previousRelationId: fromId, orgId: anchor.orgId, menteeId: anchor.menteeId },
      orderBy: { startDate: 'desc' },
      select: { id: true, startDate: true, mentor: { select: { fullName: true } } },
    });
    if (!next || seen.has(next.id)) break;
    seen.add(next.id);
    tip = { id: next.id, ownerName: next.mentor.fullName, since: next.startDate };
    fromId = next.id;
  }
  return tip ? { relationId: tip.id, ownerName: tip.ownerName, since: tip.since } : null;
}
