import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { emit } from '@/lib/events/emit';
import { redactedDiff, WEBHOOK_DIFF_SPEC } from '@/lib/events/diff';
import { resolveOrgId } from '@/lib/orgScope';
import { assertPublicHttpsUrl, SsrfBlockedError } from '@/lib/ssrfGuard';
import { integrationsLocked } from '@/lib/integrationsGate';
import { ownCompany } from '@/lib/companyIntegrations';
import { COMPANY_WEBHOOK_EVENTS, checkCompanyEventCeiling } from '@/lib/companyWebhookRule';

// Self-served webhooks for a COMPANY owner (#2006).
//
// A hook registered here carries `Webhook.companyId`: its events never exceed
// COMPANY_WEBHOOK_EVENTS (above → 403 `event_above_ceiling`, never trimmed),
// and fan-out delivers one only when the event's subject belongs to this
// company (src/lib/companyWebhookScope.ts) — the check is at delivery, so an
// admin later widening the hook's events still sends it nothing else.
//
// Same guards and audit trail as the admin path: the SSRF guard on the URL,
// the INTEGRATIONS_API plan gate on a new subscription, `webhook.created` /
// `webhook.deleted` at warning level and their events. The signing secret is
// shown once. List and delete only ever match the caller's own company.

/** Subscriptions one company may hold — an unbounded list is an amplifier. */
const MAX_HOOKS_PER_COMPANY = 10;

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const company = await ownCompany(session, 'GET /api/company/integrations/webhooks');
  if (company instanceof NextResponse) return company;
  const webhooks = await prisma.webhook.findMany({
    where: { companyId: company.id, orgId: resolveOrgId(session) },
    orderBy: { createdAt: 'desc' },
    select: { id: true, url: true, events: true, active: true, createdAt: true, lastSuccessAt: true, disabledAt: true, disabledReason: true },
  });
  return NextResponse.json({ webhooks, eventTypes: COMPANY_WEBHOOK_EVENTS });
}

const schema = z.object({
  url: z.string().url().max(500),
  events: z.array(z.string()).min(1).max(COMPANY_WEBHOOK_EVENTS.length),
});

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const company = await ownCompany(session, 'POST /api/company/integrations/webhooks');
  if (company instanceof NextResponse) return company;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', code: 'validation_failed' }, { status: 400 });
  const ceiling = checkCompanyEventCeiling(parsed.data.events);
  if (!ceiling.ok) {
    return NextResponse.json({ error: 'Event not available to a company webhook', code: 'event_above_ceiling', events: ceiling.above }, { status: 403 });
  }
  const locked = await integrationsLocked(session);
  if (locked) return locked;
  const orgId = resolveOrgId(session);
  if ((await prisma.webhook.count({ where: { companyId: company.id, orgId } })) >= MAX_HOOKS_PER_COMPANY) {
    return NextResponse.json({ error: 'Too many webhooks', code: 'limit_reached', limit: MAX_HOOKS_PER_COMPANY }, { status: 409 });
  }
  // The URL is fetched from the server's network position: the same guard as
  // the admin form, at registration (and again at every delivery).
  try {
    await assertPublicHttpsUrl(parsed.data.url);
  } catch (e) {
    return NextResponse.json({ error: e instanceof SsrfBlockedError ? e.message : 'Invalid webhook URL', code: 'invalid_url' }, { status: 400 });
  }

  const events = [...new Set(parsed.data.events)];
  const secret = randomBytes(24).toString('hex');
  const webhook = await prisma.webhook.create({ data: { url: parsed.data.url, events, secret, orgId, companyId: company.id, source: 'company' } });
  await logActivity({
    action: 'webhook.created',
    level: 'warning',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'webhook',
    targetId: webhook.id,
    detail: `${webhook.url} company=${company.id} (self-served)`,
    request,
  });
  await emit(
    'webhook.registered',
    { webhookId: webhook.id, events, changes: redactedDiff(null, { url: webhook.url, events: webhook.events, active: webhook.active }, WEBHOOK_DIFF_SPEC) },
    { orgId: webhook.orgId, actor: { id: session.user.id, type: 'user' } },
  );
  return NextResponse.json({ webhook: { id: webhook.id, url: webhook.url, events }, secret }, { status: 201 });
}

export async function DELETE(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const company = await ownCompany(session, 'DELETE /api/company/integrations/webhooks');
  if (company instanceof NextResponse) return company;
  const id = new URL(request.url).searchParams.get('id') || '';
  const where = { id, companyId: company.id, orgId: resolveOrgId(session) };
  const before = await prisma.webhook.findFirst({ where, select: { url: true, events: true, active: true, orgId: true } });
  // Another company's id matches nothing: the same 404 as a missing one.
  if (!before) return NextResponse.json({ error: 'Not found', code: 'not_found' }, { status: 404 });
  await prisma.webhook.deleteMany({ where });
  await emit(
    'webhook.deleted',
    { webhookId: id, changes: redactedDiff({ url: before.url, events: before.events, active: before.active }, null, WEBHOOK_DIFF_SPEC) },
    { orgId: before.orgId, actor: { id: session.user.id, type: 'user' } },
  );
  await logActivity({
    action: 'webhook.deleted',
    level: 'warning',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'webhook',
    targetId: id,
    detail: `company=${company.id} (self-served)`,
    request,
  });
  return NextResponse.json({ ok: true });
}
