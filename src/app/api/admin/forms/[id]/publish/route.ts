import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { FormWriteError, publishFormDefinition } from '@/lib/forms/definitions';
import { requirePermission } from '@/lib/authz';

// POST — publish a draft version of an admin-defined form (#1800). It becomes
// the live version; the older published version is archived in the same
// transaction. Publishing an already-published version is a 409.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('content.write', { request: _request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  return withTenantScope(session, async () => {
    const existing = await prisma.formDefinition.findFirst({ where: withinTenant({ id: (await params).id }, await tenantWhere(session)), select: { id: true } });
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    try {
      return NextResponse.json({ form: await publishFormDefinition(existing.id) });
    } catch (error) {
      if (error instanceof FormWriteError) return NextResponse.json({ error: error.code, code: error.code, ...error.detail }, { status: error.status });
      throw error;
    }
  });
}
