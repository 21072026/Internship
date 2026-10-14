// The machine-source registry (#2914): which `IntegrationSource` a slug names
// inside ONE organization. The only reader of the table — the account-event
// route today, a future pull job tomorrow (both resolve a source the same way).
// The only writer is the operator CLI, prisma/register-integration-source.mjs.
//
// THE RULES, each load-bearing:
//   • looked up inside the caller's org (`orgId` from the API key, never from
//     the request), so another tenant's slug is indistinguishable from an
//     unknown one;
//   • a malformed or reserved slug (src/lib/accountEventRule.ts) resolves to
//     nothing without a query;
//   • a DISABLED source resolves to nothing — "switched off" and "never
//     existed" answer the same way to a machine on the other end.
import { prisma } from '@/lib/prisma';
import { normalizeSourceSlug } from '@/lib/accountEventRule';

export interface ResolvedIntegrationSource {
  id: string;
  slug: string;
  label: string;
  /** When set, only this API key may post for the source. */
  apiKeyId: string | null;
}

export async function resolveIntegrationSource(
  orgId: string,
  rawSlug: unknown,
): Promise<ResolvedIntegrationSource | null> {
  const slug = normalizeSourceSlug(rawSlug);
  if (!slug) return null;
  const row = await prisma.integrationSource.findFirst({
    where: { orgId, slug },
    select: { id: true, slug: true, label: true, apiKeyId: true, enabled: true },
  });
  if (!row || !row.enabled) return null;
  return { id: row.id, slug: row.slug, label: row.label, apiKeyId: row.apiKeyId };
}
