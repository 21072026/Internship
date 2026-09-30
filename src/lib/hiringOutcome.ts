import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { closedAtForStatus } from '@/lib/requisitions';

// An accepted offer fills its requisition (#1411, spec #1854).
//
// "How many openings are left" used to be a number a human kept by hand:
// accepting an offer touched only the offer, and `Requisition.filled` moved
// only when someone edited the requisition. This is the one write that makes
// the funnel close itself, and it runs INSIDE the acceptance transaction, so
// the offer turning ACCEPTED and the seat being taken commit together or not
// at all.
//
// WHICH EVENT COUNTS: the offer's ACCEPTED transition, and nothing else. A move
// to a hired stage carries no requisition — `MentorshipRelation` has no link to
// one — so it has nothing it could count, and a hire can therefore never be
// counted twice (once by the offer, once by the stage).
//
// THE THREE GUARDS, each enough for its own failure mode:
//   1. Idempotency — `Offer.requisitionCountedAt` is claimed with a conditional
//      update (`where: requisitionCountedAt: null`) before the increment. A
//      replayed or concurrent accept of the SAME offer finds it claimed and
//      counts nothing. (The route's own guarded status flip already refuses a
//      second SENT → ACCEPTED; this makes the counter safe on its own.)
//   2. Capacity — the increment is a conditional `updateMany` with
//      `filled < openings` in its WHERE (a field reference, evaluated by the
//      database at write time). Two DIFFERENT offers accepted at the same
//      moment into the last seat serialise on the row lock, and the second
//      one's WHERE no longer matches: `filled` can never pass `openings`.
//   3. A cancelled requisition takes no seats — the same WHERE excludes it.
//
// A FULL REQUISITION REFUSES THE COUNT, NEVER THE ACCEPTANCE. A candidate
// accepting an offer must not be told "no" by a counter; the admin sees the
// refusal in the offer's history (the route records it) and decides.
//
// NO DECREMENT, ON PURPOSE. ACCEPTED is terminal (src/lib/offers.ts): an
// accepted offer cannot be withdrawn or expire, so there is no event that could
// give the seat back. A later "un-hire" is a human decision about the
// requisition, made on the requisition screen — do not add a half-decrement
// that guesses at it.

export type RequisitionCount =
  /** No requisition on the offer, or this offer was already counted. */
  | { outcome: 'none' }
  /** One seat taken; `nowFilled` when this acceptance took the last one. */
  | { outcome: 'counted'; requisitionId: string; filled: number; openings: number; nowFilled: boolean }
  /** The requisition is full, cancelled or gone: the acceptance stands, the count does not. */
  | { outcome: 'refused'; requisitionId: string };

export async function applyAcceptedOffer(
  tx: Prisma.TransactionClient,
  offer: { id: string; orgId: string | null; companyId: string | null; requisitionId: string | null },
  now: Date = new Date(),
): Promise<RequisitionCount> {
  const requisitionId = offer.requisitionId;
  if (!requisitionId) return { outcome: 'none' };

  const claim = await tx.offer.updateMany({
    where: { id: offer.id, requisitionCountedAt: null },
    data: { requisitionCountedAt: now },
  });
  if (claim.count === 0) return { outcome: 'none' };

  // Same ownership rule validateOfferRequisition() applied when the link was
  // made: this org, this company. Explicit, not left to the tenant middleware.
  const increment = await tx.requisition.updateMany({
    where: {
      id: requisitionId,
      ...(offer.orgId ? { orgId: offer.orgId } : {}),
      ...(offer.companyId ? { companyId: offer.companyId } : {}),
      status: { not: 'CANCELLED' },
      filled: { lt: prisma.requisition.fields.openings },
    },
    data: { filled: { increment: 1 } },
  });
  if (increment.count === 0) {
    // Not counted, so not stamped: the column only ever names offers that
    // `filled` is actually made of.
    await tx.offer.update({ where: { id: offer.id }, data: { requisitionCountedAt: null } });
    return { outcome: 'refused', requisitionId };
  }

  // The row is locked by the increment until this transaction ends, so this
  // read sees exactly the value this acceptance produced.
  const after = await tx.requisition.findUnique({
    where: { id: requisitionId },
    select: { filled: true, openings: true, status: true, closedAt: true },
  });
  if (!after) return { outcome: 'refused', requisitionId };

  const nowFilled = after.filled >= after.openings && after.status !== 'FILLED';
  if (nowFilled) {
    await tx.requisition.update({
      where: { id: requisitionId },
      data: { status: 'FILLED', closedAt: closedAtForStatus('FILLED', after.closedAt) },
    });
  }
  return { outcome: 'counted', requisitionId, filled: after.filled, openings: after.openings, nowFilled };
}

/** One line for the offer's history, so the admin sees what the acceptance did to the seat count. */
export function requisitionCountDetail(result: RequisitionCount): string | undefined {
  if (result.outcome === 'counted') {
    return `requisition ${result.requisitionId} ${result.filled}/${result.openings}${result.nowFilled ? ' filled' : ''}`;
  }
  if (result.outcome === 'refused') return `requisition ${result.requisitionId} full — not counted`;
  return undefined;
}
