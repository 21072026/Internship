import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { setSetting } from '@/lib/settings';
import { resolveSettingRaw } from '@/lib/settingsResolver';
import { logActivity } from '@/lib/activity';
import { crmBccState } from '@/lib/crmBcc';
import { nextCrmBccVersion } from '@/lib/crmBccRule';

/**
 * The org's BCC-to-CRM address (#2809) — ADMIN only, always the caller's own org.
 * GET → `{ enabled, explicit, address, domainConfigured }`.
 * POST `{ action }`:
 *   `rotate`  — a new address; the old one stops working at once;
 *   `enable` / `disable` — the org's explicit choice;
 *   `default` — back to the vertical's default (MARKETING on, INTERNSHIP off).
 */
const postSchema = z.object({ action: z.enum(['rotate', 'enable', 'disable', 'default']) });

export async function GET(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return withTenantScope(session, async () => NextResponse.json(await crmBccState(await settingsOrgOf(session))));
  });
}

export async function POST(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const parsed = postSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request', code: 'invalid' }, { status: 400 });

    return withTenantScope(session, async () => {
      const orgId = await settingsOrgOf(session);
      const { action } = parsed.data;
      if (action === 'rotate') {
        await setSetting('crmBccVersion', nextCrmBccVersion(await resolveSettingRaw('crmBccVersion', { orgId })), orgId);
      } else {
        await setSetting('crmBccEnabled', action === 'enable' ? 'true' : action === 'disable' ? 'false' : '', orgId);
      }
      await logActivity({
        action: `crmBcc.${action}`,
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'Organization',
        targetId: orgId,
        request,
      });
      return NextResponse.json(await crmBccState(orgId));
    });
  });
}
