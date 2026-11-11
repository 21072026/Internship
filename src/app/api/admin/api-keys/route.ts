import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { emit } from '@/lib/events/emit';
import { redactedDiff, API_KEY_DIFF_SPEC } from '@/lib/events/diff';
import { z } from 'zod';
import { generateApiKey } from '@/lib/apiKey';
import { resolveOrgId } from '@/lib/orgScope';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import {
  API_SCOPES,
  apiKeyStatus,
  isApiScope,
  maxApiKeyExpiry,
  parseScopes,
  publicApiScopes,
  serializeScopes,
} from '@/lib/apiScopes';
import { integrationsLocked } from '@/lib/integrationsGate';
import { currentUsage } from '@/lib/apiKeyQuota';
import { parseQuotaInput } from '@/lib/apiKeyQuotaRules';

// Admin management of programmatic API keys (#1545).
//
// The raw key is returned EXACTLY ONCE, at creation. Everything after that is a
// hash — no endpoint here ever selects `hashedKey`, let alone returns it.
//
// DELETE is a SOFT revoke: it stamps `revokedAt` and leaves the row. The
// `apikey.revoked` ActivityLog entry targets this id, so a hard delete used to
// destroy the evidence of what the key had done along with the key itself.
//
// Enforcement of expiry / revocation / scope when a key is PRESENTED is #1546.
// This route stores and reports the facts; it does not police them.
//
// Tenant scope is explicit (#2645): the list and the revoke both go through
// tenantWhere(), so they hold with MT_ENFORCE_ISOLATION off too. Relying on the
// middleware alone let any tenant's admin read every tenant's keys (with the
// creator's e-mail) and revoke them by id.

export async function GET(request: Request) {
  const gate = await requirePermission('org.integrations.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  // Never return the key/hash.
  const keys = await prisma.apiKey.findMany({
    where: withinTenant({}, await tenantWhere(session)),
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      scopes: true,
      expiresAt: true,
      revokedAt: true,
      lastUsedAt: true,
      createdAt: true,
      orgId: true,
      quotaPeriod: true,
      quotaLimit: true,
      createdBy: { select: { id: true, fullName: true, email: true } },
      // Self-served by a COMPANY owner (#2006): the admin sees whose and can revoke it.
      company: { select: { id: true, name: true } },
      // …or by a SOURCE owner, for the candidates it referred.
      source: { select: { id: true, name: true } },
    },
  });
  const now = new Date();
  // Requests this period (#2010): the key's quota period, or the month for a key without one.
  const usage = await currentUsage(keys, now);
  return NextResponse.json({
    availableScopes: API_SCOPES,
    keys: keys.map((k) => ({
      id: k.id,
      name: k.name,
      scopes: parseScopes(k.scopes),
      expiresAt: k.expiresAt,
      revokedAt: k.revokedAt,
      lastUsedAt: k.lastUsedAt,
      createdAt: k.createdAt,
      createdBy: k.createdBy ? { name: k.createdBy.fullName, email: k.createdBy.email } : null,
      company: k.company ? { id: k.company.id, name: k.company.name } : null,
      source: k.source ? { id: k.source.id, name: k.source.name } : null,
      status: apiKeyStatus(k, now),
      quotaPeriod: k.quotaPeriod,
      quotaLimit: k.quotaLimit,
      usage: usage.get(k.id) ?? null,
    })),
  });
}

const schema = z.object({
  name: z.string().min(1).max(80),
  // At least one scope: a key that can read nothing is a credential with no
  // purpose, and "no scopes" must never be read as "all scopes".
  scopes: z.array(z.string()).min(1).max(API_SCOPES.length),
  // Optional. Null / omitted means "never expires" (the UI warns about it).
  expiresAt: z.string().datetime().nullish(),
  // Optional period allowance (#2010): both or neither. Omitted = no quota.
  quotaPeriod: z.string().nullish(),
  quotaLimit: z.number().int().nullish(),
});

export async function POST(request: Request) {
  const gate = await requirePermission('org.integrations.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const scopes = parsed.data.scopes.filter(isApiScope);
  if (scopes.length === 0) {
    return NextResponse.json({ error: 'At least one valid scope is required' }, { status: 400 });
  }

  // A key that can read the public API is the paid feature (#1744); a key for
  // a registered source's account-event ingest (companies:write) is not — see
  // SCOPE_ENTITLEMENT.
  if (publicApiScopes(scopes).length > 0) {
    const locked = await integrationsLocked(session);
    if (locked) return locked;
  }

  let expiresAt: Date | null = null;
  if (parsed.data.expiresAt) {
    expiresAt = new Date(parsed.data.expiresAt);
    const now = new Date();
    if (expiresAt.getTime() <= now.getTime()) {
      return NextResponse.json({ error: 'Expiry must be in the future' }, { status: 400 });
    }
    if (expiresAt.getTime() > maxApiKeyExpiry(now).getTime()) {
      return NextResponse.json({ error: 'Expiry is too far in the future' }, { status: 400 });
    }
  }

  const quota = parseQuotaInput(parsed.data.quotaPeriod, parsed.data.quotaLimit);
  if (!quota) return NextResponse.json({ error: 'Quota needs a period (day or month) and a whole-number limit' }, { status: 400 });

  const { raw, hash } = generateApiKey();
  const key = await prisma.apiKey.create({
    data: {
      name: parsed.data.name,
      hashedKey: hash,
      scopes: serializeScopes(scopes),
      expiresAt,
      createdById: session.user.id,
      orgId: resolveOrgId(session),
      quotaPeriod: quota.quotaPeriod,
      quotaLimit: quota.quotaLimit,
    },
  });
  await logActivity({
    action: 'apikey.created',
    level: 'warning',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'apikey',
    targetId: key.id,
    detail: `${key.name} [${serializeScopes(scopes)}]`,
    request,
  });
  await emit(
    'apikey.created',
    {
      apiKeyId: key.id,
      changes: redactedDiff(
        null,
        { name: key.name, scopes: key.scopes, expiresAt: key.expiresAt, quotaPeriod: key.quotaPeriod, quotaLimit: key.quotaLimit },
        API_KEY_DIFF_SPEC,
      ),
    },
    { orgId: key.orgId, actor: { id: session.user.id, type: 'user' } },
  );
  // The raw key is shown exactly once.
  return NextResponse.json(
    {
      id: key.id,
      name: key.name,
      scopes,
      expiresAt: key.expiresAt,
      key: raw,
    },
    { status: 201 },
  );
}

export async function DELETE(request: Request) {
  const gate = await requirePermission('org.integrations.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const id = new URL(request.url).searchParams.get('id') || '';
  // Soft revoke — never `delete`. Already-revoked keys keep their first
  // revocation timestamp (the `revokedAt: null` filter makes this idempotent).
  // Another tenant's id matches no row here, so the key stays live and nothing
  // is logged — the same answer as an id that does not exist.
  const { count } = await prisma.apiKey.updateMany({
    where: withinTenant({ id, revokedAt: null }, await tenantWhere(session)),
    data: { revokedAt: new Date() },
  });
  if (count) {
    const revoked = await prisma.apiKey.findFirst({ where: withinTenant({ id }, await tenantWhere(session)), select: { orgId: true } });
    await emit('apikey.revoked', { apiKeyId: id }, { orgId: revoked?.orgId ?? null, actor: { id: session.user.id, type: 'user' } });
    await logActivity({
      action: 'apikey.revoked',
      level: 'warning',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'apikey',
      targetId: id,
      request,
    });
  }
  return NextResponse.json({ ok: true });
}

const quotaSchema = z.object({ quotaPeriod: z.string().nullish(), quotaLimit: z.number().int().nullish() }).strict();

// PATCH ?id= — set or clear a key's period allowance (#2010). Only the quota:
// scopes and expiry are fixed at minting, by design (#1545). Tenant-scoped
// like the revoke, so another tenant's id matches nothing.
export async function PATCH(request: Request) {
  const gate = await requirePermission('org.integrations.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const id = new URL(request.url).searchParams.get('id') || '';
  const parsed = quotaSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const quota = parseQuotaInput(parsed.data.quotaPeriod, parsed.data.quotaLimit);
  if (!quota) return NextResponse.json({ error: 'Quota needs a period (day or month) and a whole-number limit' }, { status: 400 });
  const { count } = await prisma.apiKey.updateMany({
    where: withinTenant({ id, revokedAt: null }, await tenantWhere(session)),
    data: quota,
  });
  if (!count) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await logActivity({
    action: 'apikey.quota_changed',
    level: 'info',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'apikey',
    targetId: id,
    detail: quota.quotaLimit === null ? 'no quota' : `${quota.quotaLimit}/${quota.quotaPeriod}`,
    request,
  });
  return NextResponse.json({ ok: true, ...quota });
}
