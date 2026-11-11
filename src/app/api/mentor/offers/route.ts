import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRoleOrPermission, type Permission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { tenantWhere } from '@/lib/tenantFilter';
import { requireCapability } from '@/lib/capabilityGate';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { OFFER_LIMITS, weekAgo } from '@/lib/mentorOfferRule';
import { OFFERABLE_MENTEE_SELECT, createMentorOffer, offerableMenteesWhere } from '@/lib/mentorOffers';

// Mentor Offers (#1809), the mentor's side. MENTOR (or an ADMIN who mentors)
// only, checked here; the tenant comes from the session. GET lists the
// mentor's own offers, their quota, and the mentees they MAY offer to — only
// those who opted in (User.openToOffers), unmatched and without a pending
// request, with profile fields only (never an address or a phone number).
// This is not a mentee directory: nobody who did not opt in is listed.

async function guard(request: Request, permission: Permission) {
  const gate = await requireRoleOrPermission(['MENTOR'], permission, { request });
  if ('error' in gate) return { error: gate.error };
  const { session } = gate;
  const denied = await requireCapability(resolveOrgId(session), 'mentorship');
  if (denied) return { error: denied };
  return { session };
}

export async function GET(request: Request) {
  const g = await guard(request, 'program.read');
  if ('error' in g) return g.error;
  const { session } = g;
  return withTenantScope(session, async () => {
    const tenant = await tenantWhere(session);
    const [offers, offerable, pending, sentLast7Days] = await Promise.all([
      prisma.mentorOffer.findMany({
        where: { mentorId: session.user.id },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true, status: true, message: true, expiresAt: true, decidedAt: true, createdAt: true, mentee: { select: { id: true, fullName: true, displayName: true } } },
      }),
      prisma.user.findMany({ where: offerableMenteesWhere(tenant), select: OFFERABLE_MENTEE_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 50 }),
      prisma.mentorOffer.count({ where: { mentorId: session.user.id, status: 'PENDING' } }),
      prisma.mentorOffer.count({ where: { mentorId: session.user.id, createdAt: { gte: weekAgo(new Date()) } } }),
    ]);
    const offeredTo = new Set(offers.filter((o) => o.status === 'PENDING' || o.status === 'DECLINED').map((o) => o.mentee.id));
    return NextResponse.json({
      offers,
      offerable: offerable.filter((m) => !offeredTo.has(m.id)),
      quota: { pending, maxPending: OFFER_LIMITS.maxPending, sentLast7Days, maxPerWeek: OFFER_LIMITS.maxPerWeek },
    });
  });
}

const schema = z.object({
  menteeId: z.string().min(1).max(64),
  message: z.string().max(TEXT_LIMITS.mentorOfferMessage).optional(),
}).strict();

export async function POST(request: Request) {
  const g = await guard(request, 'program.write');
  if ('error' in g) return g.error;
  const { session } = g;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  return withTenantScope(session, async () => {
    const result = await createMentorOffer({
      session,
      tenant: await tenantWhere(session),
      menteeId: parsed.data.menteeId,
      message: parsed.data.message?.trim() || null,
      request,
    });
    if (!result.ok) return NextResponse.json({ error: result.code, code: result.code }, { status: result.status });
    return NextResponse.json({ ok: true, id: result.offerId }, { status: 201 });
  });
}
