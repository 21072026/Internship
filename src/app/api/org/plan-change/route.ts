import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { requireCapability } from '@/lib/capabilityGate';
import { enforceRateLimit } from '@/lib/rateLimit';
import { getOrCreateSubscription } from '@/lib/subscription';
import { currentPeriod } from '@/lib/meteringRules';
import { logActivity } from '@/lib/activity';
import { notify } from '@/lib/notify';
import { getLocale } from '@/i18n/server';
import { worldOfOrg } from '@/lib/userWorld';
import { planChangeOperatorIds } from '@/lib/planChange';
import { PLAN_CHANGE_REASON_MAX, planChangeRefusal } from '@/lib/planChangeRule';
import { getPlan } from '@/lib/plans';

// A tenant admin asks for another plan (#1743); an operator applies it from
// /admin/plan-requests. There is no checkout (SELF_SERVE_CHECKOUT = false in
// src/lib/plans.ts), so this recorded request IS the upgrade path.
//
// TAKES NO orgId. The org is the session's; an `orgId` in the body is not part
// of the schema and is dropped, so no admin can file a request — or read the
// history — of another tenant. Programme side only: an org without the
// `mentorship` capability has no PROGRAM plan to move between.

const postSchema = z.object({
  requestedPlan: z.string().max(32),
  billingCycle: z.string().max(16),
  reason: z.string().trim().max(PLAN_CHANGE_REASON_MAX).optional().nullable(),
  educationClaim: z.boolean().optional(),
});

const LIST_FIELDS = {
  id: true,
  requestedPlan: true,
  billingCycle: true,
  currentPlan: true,
  activePairs: true,
  reason: true,
  educationClaim: true,
  status: true,
  handledAt: true,
  note: true,
  createdAt: true,
  updatedAt: true,
} as const;

async function gate() {
  const session = await getServerSession(authOptions);
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (session.user.role !== 'ADMIN') return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  const orgId = resolveOrgId(session);
  if (!orgId) return { error: NextResponse.json({ error: 'No organization' }, { status: 403 }) };
  const capGate = await requireCapability(orgId, 'mentorship');
  if (capGate) return { error: capGate };
  return { session, orgId };
}

// GET — the caller's own org's requests, newest first, so the billing screen
// can say "requested, waiting" or show an operator's answer.
export async function GET() {
  const g = await gate();
  if ('error' in g) return g.error;
  const { session, orgId } = g;
  return withTenantScope(session, async () => {
    const requests = await prisma.planChangeRequest.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: LIST_FIELDS,
    });
    return NextResponse.json({ requests });
  });
}

// POST — file (or update) the org's one open request.
export async function POST(request: Request) {
  const g = await gate();
  if ('error' in g) return g.error;
  const { session, orgId } = g;

  const limited = enforceRateLimit(request, 'plan-change', { limit: 5, windowMs: 60 * 60 * 1000, subject: session.user.id });
  if (limited) return limited;

  const parsed = postSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  }
  const { requestedPlan, billingCycle } = parsed.data;
  const reason = parsed.data.reason || null;
  const educationClaim = parsed.data.educationClaim ?? false;

  return withTenantScope(session, async () => {
    const sub = await getOrCreateSubscription(orgId);
    const refusal = planChangeRefusal({ requestedPlan, billingCycle, currentPlan: sub.planKey, currentInterval: sub.interval });
    if (refusal) return NextResponse.json({ error: 'Plan change refused', code: refusal }, { status: 400 });

    // The pair count as the nightly rollup last wrote it — never a live scan
    // on a request path (docs/metering.md). Null = this month not counted yet.
    const rollup = await prisma.usageRollup.findUnique({
      where: { orgId_metric_period: { orgId, metric: 'ACTIVE_MATCHED_PAIRS', period: currentPeriod() } },
      select: { value: true },
    });

    const fields = {
      requestedById: session.user.id,
      requestedPlan,
      billingCycle,
      currentPlan: sub.planKey,
      activePairs: rollup?.value ?? null,
      reason,
      educationClaim,
      locale: await getLocale(),
    };

    // One open request per org: the unique `openKey` (= orgId while NEW) turns
    // a second submit into an update of the open row. A lost create race
    // (P2002 on openKey) is retried once as that update.
    const write = () =>
      prisma.planChangeRequest.upsert({
        where: { openKey: orgId },
        create: { orgId, openKey: orgId, status: 'NEW', ...fields },
        update: fields,
        select: LIST_FIELDS,
      });
    let row;
    try {
      row = await write();
    } catch (e) {
      if ((e as { code?: string }).code !== 'P2002') throw e;
      row = await write();
    }

    await logActivity({
      action: 'org.plan_change_requested',
      actorId: session.user.id,
      actorEmail: session.user.email,
      targetType: 'organization',
      targetId: orgId,
      orgId,
      detail: `${sub.planKey}/${sub.interval} → ${requestedPlan}/${billingCycle}${educationClaim ? ' (education claim)' : ''}`,
      request,
    });

    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
    const operators = await planChangeOperatorIds(await worldOfOrg(orgId));
    await Promise.all(
      operators.map((id) => notify(id, 'plan_change.requested', { org: org?.name ?? '', plan: getPlan(requestedPlan)?.name ?? requestedPlan }, '/admin/plan-requests')),
    );

    return NextResponse.json({ request: row }, { status: 201 });
  });
}
