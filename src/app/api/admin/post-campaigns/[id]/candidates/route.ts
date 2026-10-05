import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { tenantWhere } from '@/lib/tenantFilter';
import { campaignCandidates, findCampaign } from '@/lib/postCampaign';

/**
 * GET — the accounts an admin may add to a postal campaign (#2697), each with
 * its eligibility (src/lib/postCampaignRule.ts). Ineligible ones are listed
 * WITH the reason rather than hidden: "why is this shop not in the list?" is
 * the question an admin asks next, and an objection must be visible as one.
 * `?q=` filters by name, `?stage=` by the account's funnel stage.
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

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const g = await gate();
    if ('error' in g) return g.error;
    const { session } = g;
    const { id } = await params;
    const url = new URL(request.url);
    const q = url.searchParams.get('q')?.trim().slice(0, 100) || undefined;
    const stage = url.searchParams.get('stage')?.trim().slice(0, 100) || undefined;
    return withTenantScope(session, async () => {
      const tenant = await tenantWhere(session);
      const campaign = await findCampaign(tenant, id);
      if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
      const candidates = await campaignCandidates({ tenant, campaignId: campaign.id, q, stage });
      return NextResponse.json({ candidates });
    });
  });
}
