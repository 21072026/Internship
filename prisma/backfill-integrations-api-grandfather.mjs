// Grandfather every org already USING the public API or webhooks into
// INTEGRATIONS_API, once (#1744).
//
// WHY THIS EXISTS. /api/v1 and webhook subscriptions were free until the
// INTEGRATIONS_API gate. Hardly any org has the feature from a plan yet, so the
// deploy that adds the gate would switch off integrations that run today —
// an HR system pulling candidates at 03:00 would start getting 403s. The same
// call the maintainer made for REPORT_EXPORT (#1740, 2026-10-06: existing orgs
// keep what they had, the gate applies after it) applies here, narrowed to the
// orgs that actually have an integration: an org with no key and no webhook
// had nothing to lose.
//
// WHO COUNTS AS USING IT: an org holding a live (not revoked, not expired) API
// key with a public-API scope (`candidates:read` — see SCOPE_ENTITLEMENT in
// src/lib/apiScopes.ts; an account-event ingest key is not the public API), or
// an active webhook. An org-less key or webhook belongs to the default org.
//
// RUN-ONCE, NOT RUN-ALWAYS: the grants carry GRANDFATHER_NOTE, and a later run
// that finds one does nothing — otherwise every org that later creates a key
// would be granted the feature by the next deploy.
//
// Run: node prisma/backfill-integrations-api-grandfather.mjs   [--dry-run]

import { PrismaClient } from '@prisma/client';

const FEATURE = 'INTEGRATIONS_API';
const PUBLIC_API_SCOPES = ['candidates:read'];
export const GRANDFATHER_NOTE = 'Grandfathered: API/webhooks were free before the INTEGRATIONS_API gate (#1744).';

/** Is this stored key a live public-API key at `now`? Mirrors apiKeyStatus + parseScopes. */
export function isLivePublicKey(key, now = new Date()) {
  if (key.revokedAt) return false;
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= now.getTime()) return false;
  const scopes = String(key.scopes ?? '').split(',').map((s) => s.trim());
  return scopes.some((s) => PUBLIC_API_SCOPES.includes(s));
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const prisma = new PrismaClient();
  try {
    const marked = await prisma.orgEntitlement.count({ where: { feature: FEATURE, note: GRANDFATHER_NOTE } });
    if (marked > 0) {
      console.log(`backfill-integrations-api-grandfather: already ran (${marked} grandfathered grant(s)) — nothing to do`);
      return;
    }
    const defaultOrg = await prisma.organization.findUnique({ where: { slug: 'default' }, select: { id: true } });
    const [keys, hooks] = await Promise.all([
      prisma.apiKey.findMany({ select: { orgId: true, scopes: true, revokedAt: true, expiresAt: true } }),
      prisma.webhook.findMany({ where: { active: true }, select: { orgId: true } }),
    ]);
    const orgs = new Set();
    for (const k of keys) if (isLivePublicKey(k)) orgs.add(k.orgId ?? defaultOrg?.id);
    for (const h of hooks) orgs.add(h.orgId ?? defaultOrg?.id);
    orgs.delete(undefined);
    orgs.delete(null);
    console.log(`backfill-integrations-api-grandfather: ${orgs.size} org(s) with a live integration keep it`);
    // Nobody to grandfather leaves no mark, and that is safe: once the gate is
    // live, a public-API key or a webhook cannot be CREATED without the
    // feature, so a later run can only find orgs that already have it.
    if (dryRun || orgs.size === 0) return;
    const result = await prisma.orgEntitlement.createMany({
      data: [...orgs].map((orgId) => ({ orgId, feature: FEATURE, note: GRANDFATHER_NOTE })),
      skipDuplicates: true,
    });
    console.log(`backfill-integrations-api-grandfather: granted ${FEATURE} to ${result.count} org(s)`);
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('backfill-integrations-api-grandfather failed:', error);
    process.exit(1);
  });
}
