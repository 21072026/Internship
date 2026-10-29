import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { requirePermission, type Permission } from '@/lib/authz';
import { tenantWhere } from '@/lib/tenantFilter';
import { logActivity } from '@/lib/activity';
import { campaignUpdateSchema } from '@/lib/postCampaignInput';
import { campaignResults, findCampaign } from '@/lib/postCampaign';
import { campaignShortLink } from '@/lib/postCampaignRule';
import { originForWorld } from '@/lib/hostWorld';
import { worldOfOrg } from '@/lib/userWorld';

/**
 * One postal campaign (#2697).
 * GET — the campaign, its recipients and its results.
 * PATCH — edit a DRAFT. DELETE — delete a DRAFT.
 * A SENT campaign is the record of what was posted to whom on what stated basis
 * (Art. 5 Abs. 2 DSGVO): it answers 409 `campaign_sent` to both.
 */
async function gate(permission: Permission, request: Request) {
  const authz = await requirePermission(permission, { request });
  if ('error' in authz) return { error: authz.error } as const;
  const { session } = authz;
  const gated = await requireCapability(session.user.orgId, 'companies');
  if (gated) return { error: gated } as const;
  return { session } as const;
}

const NOT_FOUND = () => NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
const SENT = () => NextResponse.json({ error: 'A sent campaign cannot be changed.', code: 'campaign_sent' }, { status: 409 });

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const g = await gate('content.read', request);
    if ('error' in g) return g.error;
    const { session } = g;
    const { id } = await params;
    return withTenantScope(session, async () => {
      const tenant = await tenantWhere(session);
      const campaign = await findCampaign(tenant, id);
      if (!campaign) return NOT_FOUND();
      const [recipients, results] = await Promise.all([
        prisma.postCampaignRecipient.findMany({
          where: { campaignId: campaign.id, orgId: campaign.orgId },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            companyId: true,
            addressBlock: true,
            sentAt: true,
            company: { select: { name: true } },
          },
        }),
        campaignResults(tenant, campaign.code),
      ]);
      return NextResponse.json({
        campaign,
        // The campaign's OWN world's origin — what the letter prints — not the
        // host this admin happens to be on.
        shortLink: campaignShortLink(originForWorld(await worldOfOrg(campaign.orgId)), campaign.code),
        recipients: recipients.map((r) => ({
          id: r.id,
          companyId: r.companyId,
          companyName: r.company.name,
          addressBlock: r.addressBlock,
          sentAt: r.sentAt,
        })),
        results,
      });
    });
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const g = await gate('content.write', request);
    if ('error' in g) return g.error;
    const { session } = g;
    const { id } = await params;
    const parsed = campaignUpdateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', code: 'invalid' }, { status: 400 });
    return withTenantScope(session, async () => {
      const campaign = await findCampaign(await tenantWhere(session), id);
      if (!campaign) return NOT_FOUND();
      // Conditional on DRAFT in the write itself: a send that lands between the
      // read and this update must not be followed by an edit of the record.
      const { count } = await prisma.postCampaign.updateMany({
        where: { id: campaign.id, orgId: campaign.orgId, status: 'DRAFT' },
        data: parsed.data,
      });
      if (count === 0) return SENT();
      return NextResponse.json({ ok: true });
    });
  });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const g = await gate('content.write', request);
    if ('error' in g) return g.error;
    const { session } = g;
    const { id } = await params;
    return withTenantScope(session, async () => {
      const campaign = await findCampaign(await tenantWhere(session), id);
      if (!campaign) return NOT_FOUND();
      const { count } = await prisma.postCampaign.deleteMany({
        where: { id: campaign.id, orgId: campaign.orgId, status: 'DRAFT' },
      });
      if (count === 0) return SENT();
      await logActivity({
        action: 'post_campaign.deleted',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'PostCampaign',
        targetId: campaign.id,
        detail: `code=${campaign.code}`,
        request,
      });
      return NextResponse.json({ ok: true });
    });
  });
}
