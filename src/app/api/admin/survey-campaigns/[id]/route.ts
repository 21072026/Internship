import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';

// Pause, resume or rename one survey campaign (#1887). The trigger itself is
// not editable: changing what a campaign means after it has sent would make
// its send history describe a different campaign — create a new one instead.

const patchSchema = z.object({ active: z.boolean().optional(), name: z.string().trim().min(1).max(120).optional() }).strict();

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input' }, { status: 400 });
  const { id } = await params;
  return withTenantScope(session, async () => {
    const updated = await prisma.surveyCampaign.updateMany({ where: withinTenant({ id }, await tenantWhere(session)), data: parsed.data });
    if (updated.count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ campaign: await prisma.surveyCampaign.findUnique({ where: { id } }) });
  });
}
