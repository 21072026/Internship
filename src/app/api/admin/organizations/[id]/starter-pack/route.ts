import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { isSuperAdminFor, logCrossTenantDenial } from '@/lib/superAdmin';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { getLocale } from '@/i18n/server';
import { applyOrgStarterPack } from '@/lib/orgStarterPack';

// POST /api/admin/organizations/[id]/starter-pack (#2066) — apply the tenant
// starter pack: stages, service levels, document requirements, an evaluation
// framework per scope and goal templates. Idempotent (src/lib/orgStarterPack.ts):
// a second call creates nothing and never overwrites what the tenant edited,
// so this is also what a "re-apply" button calls.
//
// WHO: an ADMIN of this organization, or a super admin of its world — the
// same rule as the sibling pipeline-stages route (#1535), checked here, with
// the refusal before the lookup so it cannot confirm a foreign org exists.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (!(await isSuperAdminFor(session, id))) {
    const ownOrgId = resolveOrgId(session);
    if (!ownOrgId || ownOrgId !== id) {
      await logCrossTenantDenial(session, 'POST /api/admin/organizations/[id]/starter-pack', id);
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }
  const org = await prisma.organization.findUnique({ where: { id }, select: { id: true } });
  if (!org) return NextResponse.json({ error: 'Organization not found' }, { status: 404 });

  const summary = await applyOrgStarterPack(id, { locale: await getLocale() });
  const created = Object.values(summary).reduce((n, s) => n + s.created, 0);
  await logActivity({ action: 'organization.starter_pack', actorId: session.user.id, actorEmail: session.user.email ?? null, detail: `org ${id}: created ${created}` });
  return NextResponse.json({ summary });
}
