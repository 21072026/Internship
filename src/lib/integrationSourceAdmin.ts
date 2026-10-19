// The admin side of the registered integration sources (#2978): what
// /admin/integrations lists and the three things a tenant admin may change —
// the on/off switch, the IP allowlist and the signing secret. Creating a source
// and binding it to a key stay with the operator CLI
// (prisma/register-integration-source.mjs); the slug is never edited.
//
// WHO. The ADMIN of the source's organization, or a super admin of that org's
// world (isSuperAdminFor). Anybody else asking about a source id gets the same
// 404 as for an id that does not exist — another tenant's source is not
// confirmed — and the cross-tenant try is logged (logCrossTenantDenial).
//
// WHAT IS RECORDED. Every change writes ONE AuditLog row carrying the source's
// orgId (the audit stream reads only rows with one, docs/audit-stream.md),
// naming what changed — never a secret, sealed or not.
//
// THE SECRET. Generated here, sealed with secretBox before it touches the
// database, returned to the caller ONCE and never readable again: the list
// answers only whether signing is on and since when.
//
// SERVER-ONLY: Prisma, secretBox, the super-admin lookup.
import type { Session } from 'next-auth';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { seal } from '@/lib/secretBox';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { isSuperAdminFor, logCrossTenantDenial } from '@/lib/superAdmin';
import { allowlistTexts, parseAllowlist, serializeAllowlist, type AllowlistParseResult } from '@/lib/sourceIpAllowlistRule';
import { generateSigningSecret, overlapUntil, SIGNING_SECRET_PURPOSE } from '@/lib/sourceSignatureRule';

const ROW_SELECT = {
  id: true,
  orgId: true,
  slug: true,
  label: true,
  enabled: true,
  apiKeyId: true,
  allowedIps: true,
  signingSecret: true,
  signingPreviousUntil: true,
  signingRotatedAt: true,
  createdAt: true,
} as const;

type Row = {
  id: string;
  orgId: string;
  slug: string;
  label: string;
  enabled: boolean;
  apiKeyId: string | null;
  allowedIps: string | null;
  signingSecret: string | null;
  signingPreviousUntil: Date | null;
  signingRotatedAt: Date | null;
  createdAt: Date;
};

/** What the admin screen shows of one source. No secret, sealed or plain. */
export interface SourceView {
  id: string;
  slug: string;
  label: string;
  enabled: boolean;
  boundToKey: boolean;
  allowedIps: string[];
  signing: { enabled: boolean; rotatedAt: string | null; previousValidUntil: string | null };
  lastEventAt: string | null;
  createdAt: string;
}

function view(row: Row, lastEventAt: Date | null, now = Date.now()): SourceView {
  const previousLive = row.signingPreviousUntil && row.signingPreviousUntil.getTime() > now;
  return {
    id: row.id,
    slug: row.slug,
    label: row.label,
    enabled: row.enabled,
    boundToKey: row.apiKeyId !== null,
    allowedIps: allowlistTexts(row.allowedIps),
    signing: {
      enabled: row.signingSecret !== null,
      rotatedAt: row.signingSecret && row.signingRotatedAt ? row.signingRotatedAt.toISOString() : null,
      previousValidUntil: row.signingSecret && previousLive ? row.signingPreviousUntil!.toISOString() : null,
    },
    lastEventAt: lastEventAt ? lastEventAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function lastEventBySlug(orgId: string, slugs: string[]): Promise<Map<string, Date>> {
  if (!slugs.length) return new Map();
  const groups = await prisma.integrationEvent.groupBy({
    by: ['provider'],
    where: { orgId, provider: { in: slugs } },
    _max: { createdAt: true },
  });
  return new Map(groups.filter((g) => g._max.createdAt).map((g) => [g.provider, g._max.createdAt as Date]));
}

export type Gate<T> = { ok: true; value: T } | { ok: false; response: NextResponse };

const notFound = (): Gate<never> => ({ ok: false, response: NextResponse.json({ error: 'Not found' }, { status: 404 }) });

/**
 * The org whose sources a list request reads: the caller's own, or — for a
 * super admin of its world — the one named by `?orgId=`. A tenant admin naming
 * another org is refused 403 before anything is read (the org-admin rule).
 */
export async function listOrgFor(session: Session | null, requestedOrgId: string | null): Promise<Gate<string>> {
  if (!session) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (session.user.role !== 'ADMIN') return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  const own = await settingsOrgOf(session);
  if (!requestedOrgId || requestedOrgId === own) return { ok: true, value: own };
  if (await isSuperAdminFor(session, requestedOrgId)) return { ok: true, value: requestedOrgId };
  await logCrossTenantDenial(session, '/api/admin/integration-sources', requestedOrgId);
  return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
}

export async function listSources(orgId: string): Promise<SourceView[]> {
  const rows = await prisma.integrationSource.findMany({ where: { orgId }, select: ROW_SELECT, orderBy: { slug: 'asc' } });
  const last = await lastEventBySlug(orgId, rows.map((r) => r.slug));
  return rows.map((r) => view(r, last.get(r.slug) ?? null));
}

/** The source `id` if this session may manage it; one 404 for "missing" and "not yours". */
export async function sourceFor(session: Session | null, id: string): Promise<Gate<Row>> {
  if (!session) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (session.user.role !== 'ADMIN') return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  if (!id) return notFound();
  const row = await prisma.integrationSource.findUnique({ where: { id }, select: ROW_SELECT });
  if (!row) return notFound();
  const own = await settingsOrgOf(session);
  if (row.orgId === own) return { ok: true, value: row };
  if (await isSuperAdminFor(session, row.orgId)) return { ok: true, value: row };
  await logCrossTenantDenial(session, '/api/admin/integration-sources/[id]', row.orgId);
  return notFound();
}

async function audit(session: Session, row: Row, action: string, detail: string | null): Promise<void> {
  await prisma.auditLog.create({
    data: { orgId: row.orgId, actorId: session.user.id, action, targetId: row.id, detail: detail ? `${row.slug}: ${detail}`.slice(0, 1000) : row.slug },
  });
}

async function reread(row: Row): Promise<SourceView> {
  const fresh = (await prisma.integrationSource.findUnique({ where: { id: row.id }, select: ROW_SELECT })) as Row;
  const last = await lastEventBySlug(fresh.orgId, [fresh.slug]);
  return view(fresh, last.get(fresh.slug) ?? null);
}

export interface SourcePatch {
  enabled?: boolean;
  /** One string or a list; `null` or an empty input switches the allowlist off. */
  allowedIps?: string | string[] | null;
}

export type PatchResult =
  | { ok: true; source: SourceView }
  | { ok: false; status: 400; code: 'invalid_allowed_ips'; errors: AllowlistParseResult['errors'] };

export async function patchSource(session: Session, row: Row, patch: SourcePatch): Promise<PatchResult> {
  const data: { enabled?: boolean; allowedIps?: string | null } = {};
  const changes: string[] = [];
  if (patch.allowedIps !== undefined) {
    const parsed = parseAllowlist(patch.allowedIps);
    if (parsed.errors.length) return { ok: false, status: 400, code: 'invalid_allowed_ips', errors: parsed.errors };
    const next = serializeAllowlist(parsed.entries);
    if (next !== row.allowedIps) {
      data.allowedIps = next;
      changes.push(next ? `allowed IPs ${next}` : 'allowed IPs cleared');
    }
  }
  if (patch.enabled !== undefined && patch.enabled !== row.enabled) {
    data.enabled = patch.enabled;
    changes.push(patch.enabled ? 'enabled' : 'disabled');
  }
  if (changes.length) {
    await prisma.integrationSource.updateMany({ where: { id: row.id, orgId: row.orgId }, data });
    if (data.allowedIps !== undefined) await audit(session, row, 'integration_source.allowed_ips', changes.find((c) => c.startsWith('allowed')) ?? null);
    if (data.enabled !== undefined) await audit(session, row, data.enabled ? 'integration_source.enabled' : 'integration_source.disabled', null);
  }
  return { ok: true, source: await reread(row) };
}

/**
 * Generate (first time) or rotate the signing secret. Rotation keeps the one
 * it replaces valid until `previousValidUntil`; a second rotation inside that
 * window replaces the previous one too — only the newest two ever verify.
 * The plaintext is returned here and nowhere else.
 */
export async function rotateSigningSecret(session: Session, row: Row): Promise<{ secret: string; source: SourceView }> {
  const secret = generateSigningSecret();
  const now = Date.now();
  const rotating = row.signingSecret !== null;
  await prisma.integrationSource.updateMany({
    where: { id: row.id, orgId: row.orgId },
    data: {
      signingSecret: seal(secret, SIGNING_SECRET_PURPOSE),
      signingSecretPrevious: rotating ? row.signingSecret : null,
      signingPreviousUntil: rotating ? overlapUntil(now) : null,
      signingRotatedAt: new Date(now),
    },
  });
  await audit(session, row, rotating ? 'integration_source.signing_rotated' : 'integration_source.signing_enabled', rotating ? `previous secret valid until ${overlapUntil(now).toISOString()}` : null);
  return { secret, source: await reread(row) };
}

/** Switch signing off at once: both secrets go, unsigned requests are accepted again. */
export async function disableSigning(session: Session, row: Row): Promise<SourceView> {
  if (row.signingSecret !== null) {
    await prisma.integrationSource.updateMany({
      where: { id: row.id, orgId: row.orgId },
      data: { signingSecret: null, signingSecretPrevious: null, signingPreviousUntil: null, signingRotatedAt: null },
    });
    await audit(session, row, 'integration_source.signing_disabled', null);
  }
  return reread(row);
}
