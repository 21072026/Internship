// The unassigned lead pool and "take it" (docs/integrations/klaviyo.md § Who
// owns a new lead).
//
// A lead a machine brought in — the Klaviyo connector today — has an account
// and a lead person but NO funnel record (`leadOnly` in the import writer): it
// is nobody's yet. The pool lists those leads to every sales rep of the org;
// the first rep who takes one gets the record on their own book, at the org's
// first stage. An admin can still assign it through the usual assignment.
//
// WHAT COUNTS AS AN UNASSIGNED LEAD (`poolLeadWhere`)
//   A lead person of THIS org (a MENTEE on the generated stand-in domain —
//   `import.local`, never a login), linked to an account, with NO funnel record
//   at all. Not "no ACTIVE record": a lead whose record somebody closed carries
//   that person's history, and re-opening it is an admin's transfer
//   (docs/mentor-transfer.md), not a first-come pickup — the same line
//   /api/sales/leads draws for a colleague's closed lead.
//
// ONE OWNER, EVEN UNDER A RACE (#419)
//   Two reps pressing "take" at once must not both get a record. The claim
//   locks the lead's row first (a guarded no-op update, which InnoDB holds
//   until commit), and only then asks — inside the same transaction — whether
//   the lead has any record. The second transaction waits on the lock, then
//   sees the first one's record and answers `taken`.
import { prisma } from '@/lib/prisma';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { startStageKey } from '@/lib/pipeline';
import { PLACEHOLDER_EMAIL_DOMAIN } from '@/lib/menteeAccount';
import { stageTrialWindow } from '@/lib/trialWindow';

/** The pool's rows: the newest first, at most this many per read. */
export const LEAD_POOL_LIMIT = 50;

export function poolLeadWhere(orgId: string) {
  return {
    orgId,
    role: 'MENTEE' as const,
    isActive: true,
    email: { endsWith: `@${PLACEHOLDER_EMAIL_DOMAIN}` },
    companyId: { not: null },
    menteeRelations: { none: {} },
  };
}

export interface PoolLead {
  id: string;
  fullName: string;
  phone: string | null;
  city: string | null;
  createdAt: Date;
  company: { id: string; name: string; contactEmail: string | null } | null;
  source: string | null;
}

export async function listLeadPool(orgId: string, opts: { limit?: number } = {}): Promise<{ leads: PoolLead[]; total: number }> {
  const where = poolLeadWhere(orgId);
  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(opts.limit ?? LEAD_POOL_LIMIT, LEAD_POOL_LIMIT),
      select: {
        id: true,
        fullName: true,
        phone: true,
        city: true,
        createdAt: true,
        company: { select: { id: true, name: true, contactEmail: true } },
        source: { select: { name: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);
  return {
    leads: rows.map(({ source, ...r }) => ({ ...r, source: source?.name ?? null })),
    total,
  };
}

export type ClaimOutcome =
  | { ok: true; relationId: string; stage: string }
  /** Not a lead of this org's pool (another org's id, a person, gone). */
  | { ok: false; code: 'missing' }
  /** Somebody took it first (or an admin assigned it). */
  | { ok: false; code: 'taken' };

/** Put one pool lead on `ownerId`'s book, at the org's first stage. */
export async function claimLead(input: { orgId: string; leadId: string; ownerId: string }): Promise<ClaimOutcome> {
  const { orgId, leadId, ownerId } = input;
  const stage = startStageKey(await resolvePipelineStages(orgId));
  // A pipeline whose first stage is the trial stage opens the trial window
  // here, like every other stage writer (src/lib/trialWindow.ts).
  const trialWindow = await stageTrialWindow({ orgId, toStage: stage, enteredAt: new Date(), existing: null });
  return prisma.$transaction(async (tx) => {
    // The lock comes first, so this transaction's reads below see a record a
    // concurrent claim committed while we waited on it.
    const { count } = await tx.user.updateMany({
      where: { id: leadId, orgId, role: 'MENTEE', email: { endsWith: `@${PLACEHOLDER_EMAIL_DOMAIN}` } },
      data: { updatedAt: new Date() },
    });
    if (count === 0) return { ok: false as const, code: 'missing' as const };
    const lead = await tx.user.findFirst({
      where: { id: leadId, orgId },
      select: { companyId: true, isActive: true, _count: { select: { menteeRelations: true } } },
    });
    if (!lead || !lead.isActive || !lead.companyId) return { ok: false as const, code: 'missing' as const };
    if (lead._count.menteeRelations > 0) return { ok: false as const, code: 'taken' as const };
    const relation = await tx.mentorshipRelation.create({
      data: { orgId, mentorId: ownerId, menteeId: leadId, companyId: lead.companyId, pipelineStatus: stage, ...trialWindow },
      select: { id: true },
    });
    return { ok: true as const, relationId: relation.id, stage };
  });
}
