import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { resolveOrgId } from '@/lib/orgScope';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { requireCapability } from '@/lib/capabilityGate';
import { getLocale } from '@/i18n/server';
import { isRoundEditable, PROPOSAL_ACTIONS, type ProposalAction, type RoundStatus } from '@/lib/matching/round';
import { COHORT_PASS_MAX_MENTEES } from '@/lib/matching/assign';
import { scoreSwap } from '@/lib/matching/roundSwap';

// PATCH — the round board's row actions (#1796), on a round that is still
// being worked on (DRAFT or REVIEW; a published or discarded one is 409).
//   { action: lock | unlock | discard | restore, ids }  — per row or in bulk.
//     Each move is one guarded updateMany on the states it may come from
//     (`PROPOSAL_ACTIONS`); rows that are elsewhere come back in `skipped`
//     with why, never silently. `lock` needs a mentor on the row.
//   { action: swap, id, mentorId }  — another mentor for one DRAFT row. The
//     score is recomputed HERE (`scoreSwap`); the body carries no score and a
//     stray one is refused by the strict schema. A pair a hard rule blocks —
//     the round's own reservations counted — is 409 with the rule.
const bulkSchema = z
  .object({
    action: z.enum(Object.keys(PROPOSAL_ACTIONS) as [ProposalAction, ...ProposalAction[]]),
    ids: z.array(z.string().min(1).max(64)).min(1).max(COHORT_PASS_MAX_MENTEES),
  })
  .strict();
const swapSchema = z
  .object({ action: z.literal('swap'), id: z.string().min(1).max(64), mentorId: z.string().min(1).max(64) })
  .strict();

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Ctx) {
  return withRequestScope(request, async () => {
    const gate = await requirePermission('relation.write', { request });
    if ('error' in gate) return gate.error;
    const { session } = gate;
    const denied = await requireCapability(session.user.orgId, 'mentorship');
    if (denied) return denied;
    const { id } = await params;
    const body: unknown = await request.json().catch(() => null);
    const swap = swapSchema.safeParse(body);
    const bulk = swap.success ? null : bulkSchema.safeParse(body);
    if (!swap.success && !bulk?.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

    return withTenantScope(session, async () => {
      const tenant = await tenantWhere(session);
      const round = await prisma.matchRound.findFirst({
        where: withinTenant({ id }, tenant),
        select: { id: true, status: true, orgId: true, createdAt: true },
      });
      if (!round) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      if (!isRoundEditable(round.status as RoundStatus)) {
        return NextResponse.json({ error: 'Round is final', code: 'round_final' }, { status: 409 });
      }

      if (swap.success) {
        const proposal = await prisma.matchProposal.findFirst({
          where: { id: swap.data.id, roundId: round.id },
          select: { id: true, menteeId: true, state: true },
        });
        if (!proposal) return NextResponse.json({ error: 'Not found' }, { status: 404 });
        if (proposal.state !== 'DRAFT') {
          return NextResponse.json({ error: 'Only a draft proposal can be swapped', code: 'proposal_not_draft' }, { status: 409 });
        }
        const scored = await scoreSwap({
          tenant,
          orgId: round.orgId ?? resolveOrgId(session) ?? null,
          round,
          proposalId: proposal.id,
          menteeId: proposal.menteeId,
          mentorId: swap.data.mentorId,
          locale: await getLocale(),
        });
        if (!scored.ok) {
          return NextResponse.json({ error: 'Mentor cannot take this proposal', code: scored.code }, { status: scored.code === 'mentor_not_in_pool' ? 404 : 400 });
        }
        if (scored.match.blockedBy.length > 0) {
          return NextResponse.json(
            { error: 'A hard rule blocks this pair', code: 'pair_blocked', blockedBy: scored.match.blockedBy, match: scored.match },
            { status: 409 },
          );
        }
        const moved = await prisma.matchProposal.updateMany({
          where: { id: proposal.id, state: 'DRAFT' },
          data: {
            mentorId: swap.data.mentorId,
            score: Math.round(scored.match.score),
            breakdown: scored.match.breakdown as unknown as Prisma.InputJsonValue,
            blockedBy: [],
            // Chosen by hand, not from the pass's order.
            rank: null,
            unmatchedReason: null,
            updatedById: session.user.id,
          },
        });
        if (moved.count !== 1) return NextResponse.json({ error: 'Changed meanwhile', code: 'proposal_conflict' }, { status: 409 });
        return NextResponse.json({ proposal: await prisma.matchProposal.findUnique({ where: { id: proposal.id } }) });
      }

      const { action, ids } = bulk!.data!;
      const { to, from } = PROPOSAL_ACTIONS[action];
      const rows = await prisma.matchProposal.findMany({
        where: { roundId: round.id, id: { in: [...new Set(ids)] } },
        select: { id: true, state: true, mentorId: true },
      });
      const known = new Set(rows.map((r) => r.id));
      const skipped: { id: string; reason: string }[] = ids.filter((x) => !known.has(x)).map((x) => ({ id: x, reason: 'not_found' }));
      const eligible: string[] = [];
      for (const r of rows) {
        if (!(from as readonly string[]).includes(r.state)) skipped.push({ id: r.id, reason: `state_${r.state.toLowerCase()}` });
        else if (action === 'lock' && r.mentorId === null) skipped.push({ id: r.id, reason: 'unmatched' });
        else eligible.push(r.id);
      }
      const moved = eligible.length
        ? await prisma.matchProposal.updateMany({
            where: {
              roundId: round.id,
              id: { in: eligible },
              state: { in: [...from] },
              ...(action === 'lock' ? { mentorId: { not: null } } : {}),
            },
            data: { state: to, updatedById: session.user.id },
          })
        : { count: 0 };
      // A row another admin moved between the read and the write is reported, not hidden.
      if (moved.count !== eligible.length) {
        const after = await prisma.matchProposal.findMany({ where: { id: { in: eligible } }, select: { id: true, state: true } });
        for (const r of after) if (r.state !== to) skipped.push({ id: r.id, reason: 'changed_meanwhile' });
      }
      return NextResponse.json({ action, changed: moved.count, skipped });
    });
  });
}
