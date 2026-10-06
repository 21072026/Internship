import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { tenantWhere } from '@/lib/tenantFilter';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { addRecipients, findCampaign } from '@/lib/postCampaign';

/**
 * POST `{ companyIds }` — add accounts to a DRAFT campaign; eligibility is
 * decided again on the server (an objection recorded since the picker loaded
 * wins). Answers `{ added, refused: [{ companyId, reason }] }`.
 * DELETE `?companyId=` — take one off a DRAFT.
 * A SENT campaign answers 409 `campaign_sent` to both (#2697).
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

const addSchema = z.object({ companyIds: z.array(z.string().min(1).max(64)).min(1).max(500) });
const SENT = () => NextResponse.json({ error: 'A sent campaign cannot be changed.', code: 'campaign_sent' }, { status: 409 });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const g = await gate();
    if ('error' in g) return g.error;
    const { session } = g;
    const { id } = await params;
    const parsed = addSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', code: 'invalid' }, { status: 400 });
    return withTenantScope(session, async () => {
      const tenant = await tenantWhere(session);
      const campaign = await findCampaign(tenant, id);
      if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
      if (campaign.status !== 'DRAFT') return SENT();
      const regionNames = new Intl.DisplayNames(['de'], { type: 'region' });
      const result = await addRecipients({
        campaign,
        tenant,
        companyIds: parsed.data.companyIds,
        countryName: (code) => regionNames.of(code) ?? code,
      });
      return NextResponse.json(result);
    });
  });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const g = await gate();
    if ('error' in g) return g.error;
    const { session } = g;
    const { id } = await params;
    const companyId = new URL(request.url).searchParams.get('companyId');
    if (!companyId) return NextResponse.json({ error: 'companyId is required' }, { status: 400 });
    return withTenantScope(session, async () => {
      const campaign = await findCampaign(await tenantWhere(session), id);
      if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
      if (campaign.status !== 'DRAFT') return SENT();
      await prisma.postCampaignRecipient.deleteMany({
        where: { campaignId: campaign.id, orgId: campaign.orgId, companyId, campaign: { status: 'DRAFT' } },
      });
      return NextResponse.json({ ok: true });
    });
  });
}
