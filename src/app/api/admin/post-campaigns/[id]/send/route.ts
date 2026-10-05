import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { tenantWhere } from '@/lib/tenantFilter';
import { findCampaign, markCampaignSent } from '@/lib/postCampaign';

/**
 * POST — "the letters are in the post" (#2697). Locks the campaign (DRAFT →
 * SENT, once) and stamps every recipient whose account may still be written
 * to; an account objected to since printing is skipped and counted.
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

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const g = await gate();
    if ('error' in g) return g.error;
    const { session } = g;
    const { id } = await params;
    return withTenantScope(session, async () => {
      const tenant = await tenantWhere(session);
      const campaign = await findCampaign(tenant, id);
      if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
      const outcome = await markCampaignSent({
        campaign,
        tenant,
        actor: { id: session.user.id, email: session.user.email ?? null },
        request,
      });
      if (!outcome.ok) {
        return NextResponse.json(
          { error: outcome.code === 'empty' ? 'The campaign has no recipients.' : 'The campaign was already sent.', code: outcome.code },
          { status: outcome.code === 'empty' ? 400 : 409 },
        );
      }
      return NextResponse.json(outcome);
    });
  });
}
