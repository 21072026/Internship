// Who may act on one organization's setup from /api/admin/organizations/[id]/*:
// that organization's own ADMIN, or a super admin of its world — the rule of
// the pipeline-stages route (#1535). The refusal comes before the lookup, so
// it cannot confirm whether a foreign org id exists, and a cross-tenant try is
// logged. The route reads the session itself (scripts/check-route-auth.mjs).

import { NextResponse } from 'next/server';
import type { Session } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { isSuperAdminFor, logCrossTenantDenial } from '@/lib/superAdmin';
import { resolveOrgId } from '@/lib/orgScope';

/** A response to send, or null when the session may act on `orgId`. */
export async function orgAdminRefusal(session: Session | null, orgId: string, route: string): Promise<NextResponse | null> {
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (!(await isSuperAdminFor(session, orgId))) {
    const ownOrgId = resolveOrgId(session);
    if (!ownOrgId || ownOrgId !== orgId) {
      await logCrossTenantDenial(session, route, orgId);
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } });
  if (!org) return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
  return null;
}
