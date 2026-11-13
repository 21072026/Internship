import { NextResponse } from 'next/server';
import { requireCapability } from '@/lib/capabilityGate';
import { requireCompanySeat } from '@/lib/companySeatGate';
import { requireRoleOrPermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { hasFeature } from '@/lib/entitlements';
import { talentPoolVisibleWhere, TALENT_POOL_SELECT } from '@/lib/talentPool';
import type { Prisma } from '@prisma/client';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { skillTermWhere } from '@/lib/skillFilter';
import { resolveOrgId } from '@/lib/orgScope';

// GET — premium talent-pool search for companies (Faz 1, #528). Gated by the
// TALENT_POOL_SEARCH entitlement. Privacy-safe: only surfaces mentees who have
// opted into a public profile (publicProfile=true) — the same visibility as the
// public /p/[id] page — so no mentee is exposed without their own opt-in, and
// only the public-profile fields (TALENT_POOL_SELECT): no contact details.
export async function GET(request: Request) {
  const gate = await requireRoleOrPermission(['COMPANY'], 'user.read', { request });
  if ('error' in gate) return gate.error;
  const { session, admin } = gate;
  // The company portal is the internship product's (#2348 MKT-2): a vertical
  // without `placements` has no company portal, its COMPANY logins included.
  const capGate = await requireCapability(session.user.orgId, 'placements');
  if (capGate) return capGate;
  // The seat AND the entitlement (#1870): orthogonal, both required.
  const seatGate = await requireCompanySeat(session, 'talentPool.search');
  if (seatGate) return seatGate;
  // Admins can always view (support); companies need the premium entitlement.
  if (session.user.role === 'COMPANY' && !(await hasFeature(session.user.companyId, 'TALENT_POOL_SEARCH'))) {
    // The shared gate shape (#1745), so the page renders the upgrade prompt from it.
    return NextResponse.json({ error: 'feature_locked', code: 'feature_locked', feature: 'TALENT_POOL_SEARCH' }, { status: 403 });
  }

  return await withTenantScope(session, async () => {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get('q') || '').trim().slice(0, 100);
  const skill = (searchParams.get('skill') || '').trim().slice(0, 60);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
  const pageSize = Math.min(60, Math.max(1, parseInt(searchParams.get('pageSize') || '24', 10) || 24));

  // Who is in the pool is ONE rule (src/lib/talentPool.ts), shared with the
  // introduction request (#1394) so a request never reaches a person this
  // search would not have shown.
  const where: Prisma.UserWhereInput = await talentPoolVisibleWhere({
    orgId: resolveOrgId(session),
    settingsOrgId: await settingsOrgOf(session),
    companyId: session.user.companyId,
    admin,
  });
  if (q) {
    where.OR = [
      { fullName: { contains: q } },
      { university: { contains: q } },
      { department: { contains: q } },
      { targetPosition: { contains: q } },
      { city: { contains: q } },
    ];
  }

  const select = TALENT_POOL_SELECT;
  // `id` breaks ties: rows touched by one bulk write share an `updatedAt`, and
  // without a total order MySQL may return the same row on two pages.
  const orderBy = [{ updatedAt: 'desc' as const }, { id: 'desc' as const }];

  // The count has to come from the same set the page is sliced from (#1392) —
  // and since #1820 the skill is part of that set's SQL too (`skillTermWhere`:
  // the canonical skill's labels/aliases, or a substring of the free text), so
  // this no longer loads the whole visible pool to filter it in memory.
  if (skill) where.AND = [await skillTermWhere(resolveOrgId(session), skill)];
  const total = await prisma.user.count({ where });
  const candidates = await prisma.user.findMany({
    where,
    select,
    orderBy,
    skip: (page - 1) * pageSize,
    take: pageSize,
  });

  return NextResponse.json({ candidates, total, page, pageSize });
  });
}
