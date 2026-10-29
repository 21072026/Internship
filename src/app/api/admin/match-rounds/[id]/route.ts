import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { requireCapability } from '@/lib/capabilityGate';
import { canTransitionRound, isRoundEditable, ROUND_NAME_MAX, type RoundStatus } from '@/lib/matching/round';

// One bulk matching round (#1793). GET reads it with its proposals; PATCH
// renames it or moves it DRAFT ⇄ REVIEW; DELETE discards it. Every write is a
// guarded updateMany on the status it expects, so a round that was published
// (or discarded) in between answers 409, never a silent overwrite. A PUBLISHED
// round is terminal: no edit, no discard — 409. Another tenant's round is 404.
const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(ROUND_NAME_MAX).optional(),
    status: z.enum(['DRAFT', 'REVIEW']).optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.status !== undefined, { message: 'nothing to change' });

type Ctx = { params: Promise<{ id: string }> };

async function gateFor(request: Request, permission: 'program.read' | 'relation.write') {
  const gate = await requirePermission(permission, { request });
  if ('error' in gate) return gate;
  const denied = await requireCapability(gate.session.user.orgId, 'mentorship');
  if (denied) return { error: denied };
  return gate;
}

export async function GET(request: Request, { params }: Ctx) {
  return withRequestScope(request, async () => {
    const gate = await gateFor(request, 'program.read');
    if ('error' in gate) return gate.error;
    const { session } = gate;
    const { id } = await params;
    return withTenantScope(session, async () => {
      const round = await prisma.matchRound.findFirst({
        where: withinTenant({ id }, await tenantWhere(session)),
        include: {
          cohort: { select: { id: true, name: true } },
          proposals: { orderBy: [{ state: 'asc' }, { score: 'desc' }] },
        },
      });
      if (!round) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      return NextResponse.json({ round });
    });
  });
}

export async function PATCH(request: Request, { params }: Ctx) {
  return withRequestScope(request, async () => {
    const gate = await gateFor(request, 'relation.write');
    if ('error' in gate) return gate.error;
    const { session } = gate;
    const { id } = await params;
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    return withTenantScope(session, async () => {
      const round = await prisma.matchRound.findFirst({
        where: withinTenant({ id }, await tenantWhere(session)),
        select: { id: true, status: true },
      });
      if (!round) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      const from = round.status as RoundStatus;
      if (!isRoundEditable(from)) return NextResponse.json({ error: 'Round is final', code: 'round_final' }, { status: 409 });
      const to = parsed.data.status;
      if (to && to !== from && !canTransitionRound(from, to)) {
        return NextResponse.json({ error: 'Transition not allowed', code: 'invalid_transition' }, { status: 409 });
      }
      const moved = await prisma.matchRound.updateMany({
        where: { id: round.id, status: from },
        data: { ...(parsed.data.name ? { name: parsed.data.name } : {}), ...(to ? { status: to } : {}) },
      });
      if (moved.count !== 1) return NextResponse.json({ error: 'Changed meanwhile', code: 'round_conflict' }, { status: 409 });
      return NextResponse.json({ round: await prisma.matchRound.findUnique({ where: { id: round.id } }) });
    });
  });
}

export async function DELETE(request: Request, { params }: Ctx) {
  return withRequestScope(request, async () => {
    const gate = await gateFor(request, 'relation.write');
    if ('error' in gate) return gate.error;
    const { session } = gate;
    const { id } = await params;
    return withTenantScope(session, async () => {
      const round = await prisma.matchRound.findFirst({
        where: withinTenant({ id }, await tenantWhere(session)),
        select: { id: true, status: true },
      });
      if (!round) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      const from = round.status as RoundStatus;
      if (!canTransitionRound(from, 'DISCARDED')) {
        return NextResponse.json({ error: 'Round is final', code: 'round_final' }, { status: 409 });
      }
      // Discarding is a genuine no-op on the domain: the round is marked, its
      // proposals go, and nothing else was ever written by it.
      const discarded = await prisma.$transaction(async (tx) => {
        const moved = await tx.matchRound.updateMany({ where: { id: round.id, status: from }, data: { status: 'DISCARDED' } });
        if (moved.count !== 1) return false;
        await tx.matchProposal.deleteMany({ where: { roundId: round.id } });
        return true;
      });
      if (!discarded) return NextResponse.json({ error: 'Changed meanwhile', code: 'round_conflict' }, { status: 409 });
      return NextResponse.json({ ok: true });
    });
  });
}
