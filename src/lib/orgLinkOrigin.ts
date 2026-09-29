// The origin an e-mail link for a member of `orgId` must point at (#2495, #2590).
//
// Two rules, in this order:
//   1. `Organization.publicHost` — the one EXPLICIT host mapping the schema has
//      (#2569; exact match, set by an operator). `appLinkOrigin()` in
//      src/lib/servedHosts.ts holds that rule and its reasoning: it wins only
//      if this deployment serves the host.
//   2. Otherwise the org's WORLD (docs/worlds.md, `originForWorld`): a MARKETING
//      tenant's people live on the marketing host, an INTERNSHIP tenant's on the
//      origin every link used before — which is also what a missing org, a
//      failed lookup and a vertical nobody registered fall back to, so nothing
//      that worked can start pointing somewhere new.
//
// Without rule 2 a marketing tenant that nobody mapped by hand mails its people
// into the internship host, where signing in is refused as "wrong door" — a
// person's account lives on the host of its product, and so must its links.
//
// `Organization` is not a tenant model, so this lookup is never rewritten by the
// middleware. A failed lookup is not an error for the mail.

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
  const org = await prisma.organization
    .findUnique({ where: { id: orgId }, select: { publicHost: true, vertical: true } })
    .catch(() => null);
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

/**
 * The same answer for a recipient known only by User.id — the generic footer
 * `sendEmail()` adds, whose caller passes a userId and nothing else. One round
 * trip (the org through the relation), with the same fail-open fallback.
 */
export async function appOriginForUser(userId: string | null | undefined): Promise<string> {
  if (!userId) return appLinkOrigin(null);
  const user = await prisma.user
    .findUnique({ where: { id: userId }, select: { org: { select: { publicHost: true } } } })
    .catch(() => null);
  return appLinkOrigin(user?.org?.publicHost ?? null);
}

/**
 * A per-run memo of appOriginForOrg, for a job that mails many people of few
 * tenants (a digest, a newsletter): one lookup per org, not per recipient. It
 * caches the promise, so recipients in flight together share one query. Make a
 * new one per run — never at module scope, or a mapping changed between two
 * runs would not be seen by the second.
 */
export function appOriginMemo(): (orgId: string | null | undefined) => Promise<string> {
  const cache = new Map<string, Promise<string>>();
  return (orgId) => {
    const key = orgId ?? '';
    let hit = cache.get(key);
    if (!hit) {
      hit = appOriginForOrg(orgId);
      cache.set(key, hit);
    }
    return hit;
  };
}
