import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requirePermission } from '@/lib/authz';
import { adminTierFor } from '@/lib/authzRule';
import { resolveOrgId } from '@/lib/orgScope';
import { defaultOrgId } from '@/lib/defaultOrg';
import { withTenantScope } from '@/lib/orgContext';
import { auditCsvCell } from '@/lib/auditRetentionRule';

export async function GET(request: Request) {
  const gate = await requirePermission('org.settings.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  // Org-wide contacts must not be exposed to programme admins or observers.
  if (adminTierFor(session.user.role, session.user.adminLevel) !== 'ORG_ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const orgId = resolveOrgId(session) ?? await defaultOrgId();
  return withTenantScope(session, async () => {
    const items = await prisma.subscriber.findMany({
      where: { orgId }, orderBy: { createdAt: 'desc' }, take: 1000,
      select: { id: true, email: true, role: true, locale: true, createdAt: true,
        consentAt: true, confirmedAt: true, unsubscribedAt: true, utmSource: true, utmCampaign: true },
    });
    if (new URL(request.url).searchParams.get('format') === 'csv') {
      const keys = ['email','role','locale','createdAt','consentAt','confirmedAt','unsubscribedAt','utmSource','utmCampaign'] as const;
      const csv = [keys.join(','), ...items.map(row => keys.map(key => auditCsvCell(row[key])).join(','))].join('\r\n');
      return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="subscribers.csv"', 'Cache-Control': 'no-store' } });
    }
    return NextResponse.json({ items }, { headers: { 'Cache-Control': 'no-store' } });
  });
}
