import { NextResponse } from 'next/server';
import { requireRoleOrPermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { hasFeature } from '@/lib/entitlements';
import { resolveSettingRaw } from '@/lib/settingsResolver';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { skillTermWhere } from '@/lib/skillFilter';
import { resolveOrgId } from '@/lib/orgScope';

// GET — premium talent-pool search for companies (Faz 1, #528). Gated by the
// TALENT_POOL_SEARCH entitlement. Privacy-safe: only surfaces mentees who have
// opted into a public profile (publicProfile=true) — the same visibility as the
// public /p/[id] page — so no mentee is exposed without their own opt-in.
export async function GET(request: Request) {
  const gate = await requireRoleOrPermission(['COMPANY'], 'user.read', { request });
  if ('error' in gate) return gate.error;
  const { session, admin } = gate;
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

  // Visibility = publicProfile opt-in AND an active TALENT_POOL_VISIBILITY
  // consent (#527, GDPR basis for company-facing exposure). Revoking the
  // consent removes the mentee from company search immediately.
  const where: Record<string, unknown> = {
    role: 'MENTEE',
    isActive: true,
    publicProfile: true,
    consents: { some: { type: 'TALENT_POOL_VISIBILITY', grantedAt: { not: null }, revokedAt: null } },
  };
  if (q) {
    where.OR = [
      { fullName: { contains: q } },
      { university: { contains: q } },
      { department: { contains: q } },
      { targetPosition: { contains: q } },
      { city: { contains: q } },
    ];
  }

  // Early-access window (#531): a candidate who became hireable (HIREABLE_600)
  // within the last N days is visible ONLY to premium companies holding the
  // EARLY_ACCESS entitlement (admins always see everyone). Non-entitled
  // subscribers see them once the window closes. The window length is an admin
  // setting; '0' disables it. Candidates who never became hireable, or whose
  // window has closed, are unaffected.
  //
  // Expressed as part of `where` rather than as a post-filter (#1392) so it
  // narrows the set the DB counts and paginates. Filtering it afterwards is
  // what made the old count wrong in the first place.
  const windowDays = parseInt(await resolveSettingRaw('earlyAccessWindowDays', { orgId: await settingsOrgOf(session) }), 10) || 0;
  const hasEarlyAccess = admin || (await hasFeature(session.user.companyId, 'EARLY_ACCESS'));
  if (windowDays > 0 && !hasEarlyAccess) {
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    where.NOT = {
      menteeRelations: {
        some: { statusChanges: { some: { toStatus: 'HIREABLE_600', createdAt: { gte: cutoff } } } },
      },
    };
  }

  const select = {
    id: true, fullName: true, university: true, department: true,
    graduationYear: true, city: true, targetPosition: true, skills: true, avatarUrl: true,
  } as const;
  const orderBy = { updatedAt: 'desc' } as const;

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
