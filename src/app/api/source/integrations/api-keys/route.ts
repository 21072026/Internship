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
import { ownSource } from '@/lib/sourceIntegrations';
import { apiKeyStatus, isApiScope, maxApiKeyExpiry, parseScopes, serializeScopes } from '@/lib/apiScopes';
import { SOURCE_KEY_SCOPE_CEILING, checkSourceScopeCeiling } from '@/lib/sourceApiKeyRule';
import { integrationsLocked } from '@/lib/integrationsGate';

// Self-served API keys for a SOURCE owner (#2006) — the twin of
// /api/company/integrations/api-keys, same shape and same rules.
//
// The key is bound to the caller's OWN source (`ApiKey.sourceId`); its scopes
// never exceed SOURCE_KEY_SCOPE_CEILING (the candidates the source referred,
// read-only) — a request above it is a 403, not a narrowed grant. The /api/v1
// door then admits such a key only on routes that filter by its source
// (src/lib/sourceApiKeyRule.ts).
//
// Which source is the caller's: ownSource() (src/lib/sourceIntegrations.ts),
// the fail-closed role scope, never a body field. Another source's key is
// invisible here — list and revoke both filter by the caller's source, so its
// id answers like one that does not exist.
//
// Same audit trail as the admin path: `apikey.created` / `apikey.revoked` at
// warning level, and the same events. The raw key is shown exactly once.

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const source = await ownSource(session, 'GET /api/source/integrations/api-keys');
  if (source instanceof NextResponse) return source;
  const keys = await prisma.apiKey.findMany({
    where: { sourceId: source.id, orgId: resolveOrgId(session) },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, name: true, scopes: true, expiresAt: true, revokedAt: true, lastUsedAt: true, createdAt: true,
      createdBy: { select: { fullName: true } },
    },
  });
  const now = new Date();
  return NextResponse.json({
    availableScopes: SOURCE_KEY_SCOPE_CEILING,
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
  const source = await ownSource(session, 'POST /api/source/integrations/api-keys');
  if (source instanceof NextResponse) return source;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', code: 'validation_failed' }, { status: 400 });

  const unknown = parsed.data.scopes.filter((s) => !isApiScope(s));
  if (unknown.length) return NextResponse.json({ error: 'Unknown scope', code: 'unknown_scope', scopes: unknown }, { status: 400 });
  const ceiling = checkSourceScopeCeiling(parsed.data.scopes);
  if (!ceiling.ok) {
    return NextResponse.json({ error: 'Scope above what a source key may hold', code: 'scope_above_ceiling', scopes: ceiling.above }, { status: 403 });
  }
  // The API is the paid feature (#1744), for a source owner as for an admin.
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
      sourceId: source.id,
    },
  });
  await logActivity({
    action: 'apikey.created',
    level: 'warning',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'apikey',
    targetId: key.id,
    detail: `${key.name} [${serializeScopes(scopes)}] source=${source.id} (self-served)`,
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
  const source = await ownSource(session, 'DELETE /api/source/integrations/api-keys');
  if (source instanceof NextResponse) return source;
  const id = new URL(request.url).searchParams.get('id') || '';
  // Soft revoke, idempotent, and only this source's own keys: another
  // source's id matches nothing and answers like a missing one.
  const { count } = await prisma.apiKey.updateMany({
    where: { id, sourceId: source.id, orgId: resolveOrgId(session), revokedAt: null },
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
    detail: `source=${source.id} (self-served)`,
    request,
  });
  return NextResponse.json({ ok: true });
}
