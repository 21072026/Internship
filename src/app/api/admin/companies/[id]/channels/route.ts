import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { logActivity } from '@/lib/activity';
import { CHANNEL_STATUSES, isChannelKey } from '@/lib/salesChannels';

/**
 * An account's sales channels (#2408), by hand — ADMIN only, `companies` module.
 * PUT `{ channel, status }` adds the channel or sets its status;
 * DELETE `{ channel }` removes it. The key must be one of the vocabulary
 * (src/lib/salesChannels.ts). Another tenant's company id is the same 404 as
 * one that does not exist; the row is written with the company's own orgId.
 */
async function gate() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as const;
  }
  const gated = await requireCapability(session.user.orgId, 'companies');
  if (gated) return { error: gated } as const;
  return { session } as const;
}

const channelField = z.string().refine(isChannelKey, 'unknown channel');
const putSchema = z.object({ channel: channelField, status: z.enum(CHANNEL_STATUSES) });
const deleteSchema = z.object({ channel: channelField });

async function handle(request: Request, params: Promise<{ id: string }>, method: 'PUT' | 'DELETE') {
  return withRequestScope(request, async () => {
    const g = await gate();
    if ('error' in g) return g.error;
    const { session } = g;
    const { id } = await params;
    const body = await request.json().catch(() => null);
    const parsed = method === 'PUT' ? putSchema.safeParse(body) : deleteSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request', code: 'invalid' }, { status: 400 });

    return withTenantScope(session, async () => {
      const company = await prisma.company.findFirst({
        where: withinTenant({ id }, await tenantWhere(session)),
        select: { id: true, orgId: true },
      });
      if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 });
      const { channel } = parsed.data;
      const key = { companyId_channel: { companyId: company.id, channel } };
      if (method === 'PUT') {
        const status = (parsed.data as z.infer<typeof putSchema>).status;
        await prisma.companyChannel.upsert({
          where: key,
          create: { orgId: company.orgId, companyId: company.id, channel, status },
          update: { status },
        });
      } else {
        await prisma.companyChannel.deleteMany({ where: { companyId: company.id, channel } });
      }
      await logActivity({
        action: method === 'PUT' ? 'company.channel.set' : 'company.channel.removed',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'Company',
        targetId: company.id,
        detail: method === 'PUT' ? `channel=${channel} status=${(parsed.data as z.infer<typeof putSchema>).status}` : `channel=${channel}`,
        request,
      });
      return NextResponse.json({ ok: true });
    });
  });
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(request, params, 'PUT');
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(request, params, 'DELETE');
}
