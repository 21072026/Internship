import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { defaultOrgId } from '@/lib/defaultOrg';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { requirePermission } from '@/lib/authz';
import { FORM_SURFACES } from '@/lib/forms/definitionRule';
import { activeForms, ownAnswers, publicForm } from '@/lib/forms/active';

// GET — a participant's answers to the admin-defined questions (#1803), for
// the admin detail views: every live form the person's role is asked, on
// every surface, with their latest answer per field. Read-only. A user
// outside the caller's tenant is 404, the same as one that does not exist.

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('user.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const { id } = await params;
  return withTenantScope(session, async () => {
    const user = await prisma.user.findFirst({ where: withinTenant({ id }, await tenantWhere(session)), select: { id: true, role: true } });
    if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const orgId = resolveOrgId(session) ?? (await defaultOrgId());
    const forms = (await Promise.all(FORM_SURFACES.map((surface) => activeForms(orgId, surface, user.role)))).flat();
    const answers = await ownAnswers(user.id, forms);
    return NextResponse.json({
      forms: forms
        .map((f) => ({ ...publicForm(f), surface: f.surface, answers: answers[f.key] ?? {} }))
        .filter((f) => f.fields.length > 0),
    });
  });
}
