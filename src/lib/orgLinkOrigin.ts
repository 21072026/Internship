// The origin an e-mail link for a member of `orgId` must point at (#2495, #2590).
//
// Two rules, in this order:
//   1. `Organization.publicHost` — the one EXPLICIT host mapping the schema has
//      (#2569; exact match, set by an operator). `appLinkOrigin()` in
//      src/lib/servedHosts.ts holds that rule and its reasoning: it wins only
//      if this deployment serves the host.
//   2. Otherwise the org's WORLD (docs/worlds.md, `originForWorld`): a MARKETING
//      tenant's people live on the marketing host, an INTERNSHIP tenant's on the
//      origin every link used before — which is also what a missing org and a
//      vertical nobody registered fall back to, so nothing that worked can
//      start pointing somewhere new.
//
// Without rule 2 a marketing tenant that nobody mapped by hand mails its people
// into the internship host, where signing in is refused as "wrong door" — a
// person's account lives on the host of its product, and so must its links.
//
// `Organization` is not a tenant model, so this lookup is never rewritten by the
// middleware. A failed lookup THROWS: answering the default origin for it put a
// marketing tenant's reset, invitation and unsubscribe links on the internship
// host during a database error, and every caller already handles a throw from
// the mail it is building (emailService.ts, "A LOOKUP THAT FAILS FAILS LOUD").

import { prisma } from '@/lib/prisma';
import { appLinkOrigin } from '@/lib/servedHosts';
import { originForWorld } from '@/lib/hostWorld';
import { toVerticalKey } from '@/lib/verticals';

type OrgLinkRow = { publicHost: string | null; vertical: string | null } | null | undefined;

/** The rule on an already-read organization row — shared by the single and the batched read. */
export function linkOriginForOrgRow(org: OrgLinkRow): string {
  const legacy = appLinkOrigin(null);
  const explicit = appLinkOrigin(org?.publicHost ?? null);
  // `appLinkOrigin` answers the legacy origin both for "no usable mapping" and
  // for "mapped to the configured host itself"; either way rule 2 is right.
  if (explicit !== legacy) return explicit;
  return originForWorld(toVerticalKey(org?.vertical));
}

export async function appOriginForOrg(orgId: string | null | undefined): Promise<string> {
  if (!orgId) return appLinkOrigin(null);
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { publicHost: true, vertical: true },
  });
  return linkOriginForOrgRow(org);
}

/**
 * The same answer for many organizations with ONE query — for the crons that
 * loop over hundreds of recipients. Unknown ids are absent from the map; the
 * caller falls back to `appLinkOrigin(null)` like the single form does.
 */
export async function appOriginsForOrgs(orgIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(orgIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await prisma.organization.findMany({
    where: { id: { in: ids } },
    select: { id: true, publicHost: true, vertical: true },
  });
  return new Map(rows.map((r) => [r.id, linkOriginForOrgRow(r)]));
}
