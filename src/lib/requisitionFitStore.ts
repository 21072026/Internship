// The only writer of `RequisitionFit` (#2042): the fit score a candidate had
// against a requisition when a person was shown it, kept so that a ranking
// somebody acted on can be explained later (score, breakdown, rule-set version,
// and the written reason once there is one).
//
// Server-only. A row is written only when its numbers CHANGED, so showing the
// same list twice is a read, not 50 writes. Never throws into its caller: the
// record is an audit trail beside the screen, and failing to keep it must not
// take the list away (it is logged instead).
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { FitScore } from '@/lib/matching/requisitionFit';

export interface FitRecord {
  menteeId: string;
  fit: FitScore;
  /** Only passed by the reason writer; omitted = keep the stored sentence. */
  reason?: { text: string; source: 'AI' | 'RULE' } | null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function recordRequisitionFits(orgId: string, requisitionId: string, records: readonly FitRecord[]): Promise<void> {
  if (records.length === 0) return;
  try {
    const existing = new Map(
      (
        await prisma.requisitionFit.findMany({
          where: { orgId, requisitionId, menteeId: { in: records.map((r) => r.menteeId) } },
          select: { menteeId: true, score: true, breakdown: true, ruleSetVersion: true, reason: true },
        })
      ).map((r) => [r.menteeId, r])
    );
    for (const r of records) {
      const prior = existing.get(r.menteeId);
      const breakdown = r.fit.breakdown as unknown as Prisma.InputJsonValue;
      const reasonChanged = r.reason !== undefined && (r.reason?.text ?? null) !== (prior?.reason ?? null);
      if (
        prior &&
        prior.score === r.fit.score &&
        prior.ruleSetVersion === r.fit.ruleSetVersion &&
        same(prior.breakdown, r.fit.breakdown) &&
        !reasonChanged
      ) {
        continue;
      }
      const reasonData =
        r.reason === undefined ? {} : { reason: r.reason?.text ?? null, reasonSource: r.reason?.source ?? null };
      await prisma.requisitionFit.upsert({
        where: { requisitionId_menteeId: { requisitionId, menteeId: r.menteeId } },
        update: { score: r.fit.score, breakdown, ruleSetVersion: r.fit.ruleSetVersion, computedAt: new Date(), ...reasonData },
        create: {
          orgId,
          requisitionId,
          menteeId: r.menteeId,
          score: r.fit.score,
          breakdown,
          ruleSetVersion: r.fit.ruleSetVersion,
          ...reasonData,
        },
      });
    }
  } catch (error) {
    console.error('recordRequisitionFits failed:', { orgId, requisitionId, error });
  }
}
