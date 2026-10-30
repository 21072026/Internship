import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { emit } from '@/lib/events/emit';
import { redactedDiff, API_KEY_DIFF_SPEC } from '@/lib/events/diff';
import { generateApiKey } from '@/lib/apiKey';
import { resolveOrgId } from '@/lib/orgScope';
import { ownCompany } from '@/lib/companyIntegrations';
import { apiKeyStatus, isApiScope, maxApiKeyExpiry, parseScopes, serializeScopes } from '@/lib/apiScopes';
import { COMPANY_KEY_SCOPE_CEILING, checkCompanyScopeCeiling } from '@/lib/companyApiKeyRule';
import { integrationsLocked } from '@/lib/integrationsGate';

// Self-served API keys for a COMPANY owner (#2006).
//
// The admin path (/api/admin/api-keys) mints org-wide keys; this one mints a key
// bound to the caller's OWN company (`ApiKey.companyId`), whose scopes never
// exceed COMPANY_KEY_SCOPE_CEILING — a request above it is a 403, not a
// narrowed grant. The /api/v1 door then admits such a key only on routes that
// filter by its company (src/lib/companyApiKeyRule.ts).
//
// Which company is the caller's: ownCompany() (src/lib/companyIntegrations.ts),
// the fail-closed role scope, never a body field. Another company's key is
// invisible here — the list and the revoke both filter by the
// caller's company, so its id answers like one that does not exist.
//
// Same audit trail as the admin path: `apikey.created` / `apikey.revoked` at
// warning level, and the same events. The raw key is shown exactly once.

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const company = await ownCompany(session, 'GET /api/company/integrations/api-keys');
  if (company instanceof NextResponse) return company;
  const keys = await prisma.apiKey.findMany({
    where: { companyId: company.id, orgId: resolveOrgId(session) },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, name: true, scopes: true, expiresAt: true, revokedAt: true, lastUsedAt: true, createdAt: true,
      createdBy: { select: { fullName: true } },
    },
  });
  const now = new Date();
  return NextResponse.json({
    availableScopes: COMPANY_KEY_SCOPE_CEILING,
    keys: keys.map((k) => ({
      id: k.id,
      name: k.name,
      scopes: parseScopes(k.scopes),
      expiresAt: k.expiresAt,
      revokedAt: k.revokedAt,
      lastUsedAt: k.lastUsedAt,
      createdAt: k.createdAt,
      createdBy: k.createdBy ? { name: k.createdBy.fullName } : null,
      status: apiKeyStatus(k, now),
    })),
  });
}

const schema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.string()).min(1).max(10),
  // Required here, unlike the admin path: a self-served credential is never permanent.
  expiresAt: z.string().datetime(),
});

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const company = await ownCompany(session, 'POST /api/company/integrations/api-keys');
  if (company instanceof NextResponse) return company;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', code: 'validation_failed' }, { status: 400 });

  const unknown = parsed.data.scopes.filter((s) => !isApiScope(s));
  if (unknown.length) return NextResponse.json({ error: 'Unknown scope', code: 'unknown_scope', scopes: unknown }, { status: 400 });
  const ceiling = checkCompanyScopeCeiling(parsed.data.scopes);
  if (!ceiling.ok) {
    return NextResponse.json({ error: 'Scope above what a company key may hold', code: 'scope_above_ceiling', scopes: ceiling.above }, { status: 403 });
  }
  // The API is the paid feature (#1744), for a company owner as for an admin.
  const locked = await integrationsLocked(session);
  if (locked) return locked;

  const now = new Date();
  const expiresAt = new Date(parsed.data.expiresAt);
  if (expiresAt.getTime() <= now.getTime()) return NextResponse.json({ error: 'Expiry must be in the future', code: 'expiry_past' }, { status: 400 });
  if (expiresAt.getTime() > maxApiKeyExpiry(now).getTime()) {
    return NextResponse.json({ error: 'Expiry is too far in the future', code: 'expiry_too_far' }, { status: 400 });
  }

  const scopes = [...new Set(parsed.data.scopes)];
  const { raw, hash } = generateApiKey();
  const key = await prisma.apiKey.create({
    data: {
      name: parsed.data.name,
      hashedKey: hash,
      scopes: serializeScopes(scopes),
      expiresAt,
      createdById: session.user.id,
      orgId: resolveOrgId(session),
      companyId: company.id,
    },
  });
  await logActivity({
    action: 'apikey.created',
    level: 'warning',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'apikey',
    targetId: key.id,
    detail: `${key.name} [${serializeScopes(scopes)}] company=${company.id} (self-served)`,
    request,
  });
  await emit(
    'apikey.created',
    { apiKeyId: key.id, changes: redactedDiff(null, { name: key.name, scopes: key.scopes, expiresAt: key.expiresAt }, API_KEY_DIFF_SPEC) },
    { orgId: key.orgId, actor: { id: session.user.id, type: 'user' } },
  );
  return NextResponse.json({ id: key.id, name: key.name, scopes, expiresAt: key.expiresAt, key: raw }, { status: 201 });
}

export async function DELETE(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const company = await ownCompany(session, 'DELETE /api/company/integrations/api-keys');
  if (company instanceof NextResponse) return company;
  const id = new URL(request.url).searchParams.get('id') || '';
  // Soft revoke, idempotent, and only this company's own keys: another
  // company's id matches nothing and answers like a missing one.
  const { count } = await prisma.apiKey.updateMany({
    where: { id, companyId: company.id, orgId: resolveOrgId(session), revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (!count) return NextResponse.json({ error: 'Not found', code: 'not_found' }, { status: 404 });
  await emit('apikey.revoked', { apiKeyId: id }, { orgId: resolveOrgId(session), actor: { id: session.user.id, type: 'user' } });
  await logActivity({
    action: 'apikey.revoked',
    level: 'warning',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'apikey',
    targetId: id,
    detail: `company=${company.id} (self-served)`,
    request,
  });
  return NextResponse.json({ ok: true });
}
