import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { z } from 'zod';
import { generateApiKey } from '@/lib/apiKey';
import { resolveOrgId } from '@/lib/orgScope';
import {
  API_SCOPES,
  apiKeyStatus,
  isApiScope,
  maxApiKeyExpiry,
  parseScopes,
  serializeScopes,
} from '@/lib/apiScopes';

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

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return session && session.user.role === 'ADMIN' ? session : null;
}

export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // Never return the key/hash.
  const keys = await prisma.apiKey.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      scopes: true,
      expiresAt: true,
      revokedAt: true,
      lastUsedAt: true,
      createdAt: true,
      createdBy: { select: { id: true, fullName: true, email: true } },
    },
  });
  const now = new Date();
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
      status: apiKeyStatus(k, now),
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
});

export async function POST(request: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const scopes = parsed.data.scopes.filter(isApiScope);
  if (scopes.length === 0) {
    return NextResponse.json({ error: 'At least one valid scope is required' }, { status: 400 });
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

  const { raw, hash } = generateApiKey();
  const key = await prisma.apiKey.create({
    data: {
      name: parsed.data.name,
      hashedKey: hash,
      scopes: serializeScopes(scopes),
      expiresAt,
      createdById: session.user.id,
      orgId: resolveOrgId(session),
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
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const id = new URL(request.url).searchParams.get('id') || '';
  // Soft revoke — never `delete`. Already-revoked keys keep their first
  // revocation timestamp (the `revokedAt: null` filter makes this idempotent).
  const { count } = await prisma.apiKey.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (count) {
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
