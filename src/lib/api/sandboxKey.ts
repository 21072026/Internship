import { prisma } from '@/lib/prisma';
import { generateApiKey } from '@/lib/apiKey';
import { serializeScopes } from '@/lib/apiScopes';
import { defaultOrgId } from '@/lib/defaultOrg';
import { logActivity } from '@/lib/activity';
import { runUnscoped } from '@/lib/tenantAmbient';
import {
  MAX_LIVE_SANDBOX_KEYS,
  SANDBOX_DAILY_QUOTA,
  SANDBOX_KEY_NAME,
  SANDBOX_KEY_TTL_MS,
  SANDBOX_SCOPES,
} from '@/lib/api/sandboxKeyRule';

// Mints a sandbox key (#1992). The caller has already checked sandboxEnabled();
// the rules and the reasons are in sandboxKeyRule.ts. The raw key leaves this
// function exactly once, like an admin-minted one (/api/admin/api-keys).
export type SandboxMint = { ok: true; key: string; expiresAt: Date; scopes: readonly string[] } | { ok: false; reason: 'capacity' };

export async function mintSandboxKey(now: Date = new Date()): Promise<SandboxMint> {
  const orgId = await defaultOrgId();
  const live = await runUnscoped(() =>
    prisma.apiKey.count({ where: { orgId, name: SANDBOX_KEY_NAME, revokedAt: null, expiresAt: { gt: now } } }),
  );
  if (live >= MAX_LIVE_SANDBOX_KEYS) return { ok: false, reason: 'capacity' };
  const { raw, hash } = generateApiKey();
  const expiresAt = new Date(now.getTime() + SANDBOX_KEY_TTL_MS);
  const row = await runUnscoped(() =>
    prisma.apiKey.create({
      data: {
        name: SANDBOX_KEY_NAME,
        hashedKey: hash,
        scopes: serializeScopes([...SANDBOX_SCOPES]),
        expiresAt,
        createdById: null,
        orgId,
        quotaPeriod: 'day',
        quotaLimit: SANDBOX_DAILY_QUOTA,
      },
      select: { id: true },
    }),
  );
  await logActivity({ action: 'apikey.sandbox_created', targetType: 'ApiKey', targetId: row.id, orgId, detail: 'developer portal sandbox' });
  return { ok: true, key: raw, expiresAt, scopes: SANDBOX_SCOPES };
}
