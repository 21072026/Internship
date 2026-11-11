import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { prisma } from '@/lib/prisma';
import { resolveOrgId } from '@/lib/orgScope';
import { defaultOrgId } from '@/lib/defaultOrg';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { isLocale, type Locale } from '@/i18n/config';
import { isValidAudienceInput, parseAudience } from '@/lib/announcementAudience';
import { announcementMailRecipients, announcementRecipients } from '@/lib/announcementSend';

// The composer's audience helpers (#1721).
//
// GET  — what the audience picker may offer: the tenant's programmes, pipeline
//        stages, companies and tags. Choices only; the server still resolves the
//        criteria itself at send time.
// POST — { audience } → how many active people it reaches NOW and how many of
//        them a mail would reach, through the very functions the send uses, so
//        the estimate and the delivery cannot be two different counts.

export async function GET(request: Request) {
  const gate = await requirePermission('content.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  return withTenantScope(session, async () => {
    const tenant = await tenantWhere(session);
    const orgId = resolveOrgId(session) ?? (await defaultOrgId());
    const [cohorts, companies, tags, stages] = await Promise.all([
      prisma.cohort.findMany({ where: withinTenant({}, tenant), select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 200 }),
      prisma.company.findMany({ where: withinTenant({}, tenant), select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 500 }),
      prisma.tag.findMany({ where: { orgId }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 200 }),
      resolvePipelineStages(orgId, isLocale(new URL(request.url).searchParams.get('locale')) ? (new URL(request.url).searchParams.get('locale') as Locale) : 'en'),
    ]);
    return NextResponse.json({ cohorts, companies, tags, stages: stages.map((s) => ({ key: s.key, label: s.label })) });
  });
}

export async function POST(request: Request) {
  const gate = await requirePermission('content.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const body = (await request.json().catch(() => null)) as { audience?: unknown } | null;
  if (!body || !isValidAudienceInput(body.audience)) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  return withTenantScope(session, async () => {
    const users = await announcementRecipients(await tenantWhere(session), parseAudience(body.audience));
    return NextResponse.json({ recipients: users.length, emailable: announcementMailRecipients(users).length });
  });
}
