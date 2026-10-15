import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { setSetting } from '@/lib/settings';
import { logActivity } from '@/lib/activity';
import { letterTemplateSchema } from '@/lib/postCampaignInput';
import { campaignDefaultsFor } from '@/lib/postCampaign';

/**
 * The organization's own default letter for new postal campaigns (#2927).
 * PUT `{ letterBody }` — saves it as the `postLetterTemplate` setting of the
 * caller's OWN org; `''` removes it, so new campaigns start from the built-in
 * letter again. Answers with the defaults a new campaign now starts from.
 *
 * ADMIN only, `companies` module — the same gate as the campaigns themselves.
 * The org is the session's (`settingsOrgOf`), never taken from the body, and
 * the row written is that org's, never the global one. A campaign already
 * created keeps its own letter: this only changes where the next one starts.
 */
export async function PUT(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const gated = await requireCapability(session.user.orgId, 'companies');
    if (gated) return gated;

    const parsed = letterTemplateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', code: 'invalid' }, { status: 400 });

    const orgId = await settingsOrgOf(session);
    return withTenantScope(session, async () => {
      await setSetting('postLetterTemplate', parsed.data.letterBody, orgId);
      await logActivity({
        action: parsed.data.letterBody ? 'post_campaign.letter_template_saved' : 'post_campaign.letter_template_cleared',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        request,
      });
      return NextResponse.json({ defaults: await campaignDefaultsFor(orgId) });
    });
  });
}
