import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { campaignCodeFrom } from '@/lib/postCampaignRule';
import { campaignCreateSchema } from '@/lib/postCampaignInput';
import { campaignDefaultsFor, campaignResults } from '@/lib/postCampaign';
import { settingsOrgOf } from '@/lib/settingsOrg';

/**
 * Postal campaigns (#2697, docs/marketing-vertical/postal-campaigns.md).
 * GET — the tenant's campaigns with recipient counts and results, plus the
 * texts a new campaign starts from (`defaults`: the org's own letter or the
 * built-in one, #2927).
 * POST — a new DRAFT campaign. The data source and the balancing note are
 * REQUIRED: without them the letter has no Art. 14 notice to print and the
 * campaign no Art. 6(1)(f) record — a campaign that cannot answer "where did
 * you get my address?" is not one this tool starts.
 *
 * ADMIN only, `companies` module; every read narrowed to the caller's tenant
 * by hand (the middleware filters nothing while isolation is off).
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

export async function GET(request: Request) {
  return withRequestScope(request, async () => {
    const g = await gate();
    if ('error' in g) return g.error;
    const { session } = g;
    return withTenantScope(session, async () => {
      const tenant = await tenantWhere(session);
      const campaigns = await prisma.postCampaign.findMany({
        where: withinTenant({}, tenant),
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          name: true,
          code: true,
          status: true,
          sentAt: true,
          createdAt: true,
          _count: { select: { recipients: true } },
        },
      });
      const results = await Promise.all(campaigns.map((c) => campaignResults(tenant, c.code)));
      const defaults = await campaignDefaultsFor(await settingsOrgOf(session));
      return NextResponse.json({
        defaults,
        campaigns: campaigns.map((c, i) => ({
          id: c.id,
          name: c.name,
          code: c.code,
          status: c.status,
          sentAt: c.sentAt,
          createdAt: c.createdAt,
          recipients: c._count.recipients,
          ...results[i],
        })),
      });
    });
  });
}

export async function POST(request: Request) {
  return withRequestScope(request, async () => {
    const g = await gate();
    if ('error' in g) return g.error;
    const { session } = g;
    const parsed = campaignCreateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', code: 'invalid' }, { status: 400 });

    return withTenantScope(session, async () => {
      const orgId = resolveOrgId(session);
      const tenant = await tenantWhere(session);
      const code = parsed.data.code || campaignCodeFrom(parsed.data.name);
      const taken = await prisma.postCampaign.findFirst({ where: withinTenant({ code }, tenant), select: { id: true } });
      if (taken) return NextResponse.json({ error: 'This campaign code is already used.', code: 'code_taken' }, { status: 409 });

      const campaign = await prisma.postCampaign.create({
        data: {
          orgId,
          name: parsed.data.name,
          code,
          dataSource: parsed.data.dataSource,
          balancingNote: parsed.data.balancingNote,
          letterBody: parsed.data.letterBody,
          createdById: session.user.id,
        },
        select: { id: true, code: true },
      });
      await logActivity({
        action: 'post_campaign.created',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'PostCampaign',
        targetId: campaign.id,
        detail: `code=${campaign.code}`,
        request,
      });
      return NextResponse.json(campaign, { status: 201 });
    });
  });
}
