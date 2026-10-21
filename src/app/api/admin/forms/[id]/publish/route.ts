import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { FormWriteError, publishFormDefinition } from '@/lib/forms/definitions';

// POST — publish a draft version of an admin-defined form (#1800). It becomes
// the live version; the older published version is archived in the same
// transaction. Publishing an already-published version is a 409.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
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
