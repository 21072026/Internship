import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { requireCapability } from '@/lib/capabilityGate';

// A partner accepts the contract version they were shown. The version is checked
// against the organisation's current one, so an old page cannot accept a new text.
const bodySchema = z.object({ version: z.number().int().positive() });

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'AFFILIATE' || !session.user.orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const orgId = session.user.orgId;
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  return withTenantScope(session, async () => {
    const settings = await prisma.affiliateProgramSettings.findUnique({
      where: { orgId },
      select: { contractVersion: true },
    });
    if (!settings) return NextResponse.json({ error: 'not_configured' }, { status: 404 });
    if (parsed.data.version !== settings.contractVersion) {
      return NextResponse.json({ error: 'stale_version', current: settings.contractVersion }, { status: 409 });
    }
    const partner = await prisma.affiliatePartner.findFirst({
      where: { userId: session.user.id, orgId },
      select: { id: true },
    });
    if (!partner) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    await prisma.affiliateContractAcceptance.upsert({
      where: { partnerId_version: { partnerId: partner.id, version: settings.contractVersion } },
      update: {},
      create: { orgId, partnerId: partner.id, version: settings.contractVersion },
    });
    return NextResponse.json({ ok: true, version: settings.contractVersion });
  });
}
