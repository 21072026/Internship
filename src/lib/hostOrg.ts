// Host → tenant, the database half (#1661). Server-only (Prisma). The rule and
// its trust reasoning are in ./hostOrgRule.ts; this file reads the two inputs
// it needs — a VERIFIED `Organization.publicHost`, or a slug under
// APP_ROOT_DOMAIN — and caches the answer, because it runs on public requests.
//
// Not to be confused with src/lib/publicHostOrg.ts (#2569): that one files a
// sessionless demo form into the org an OPERATOR mapped a host to, verified or
// not. This one answers "whose domain is this" for branding and SSO discovery,
// and only a DNS-proven claim counts.
//
// `Organization` is not a tenant model, so these lookups are never rewritten by
// the tenant middleware; the `where` is the whole rule.

import type { OrgPlan } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { normalizeHost, normalizeRootDomain, slugUnderRootDomain } from '@/lib/hostOrgRule';
import { servedHosts } from '@/lib/servedHosts';

export interface HostOrg {
  id: string;
  slug: string;
  plan: OrgPlan;
}

const TTL_MS = 60_000;
// The hosts come from request headers and RelayState — attacker-chosen — so a
// cache keyed on them is bounded: past this many entries it starts over.
const MAX_ENTRIES = 1_000;
function remember<V>(map: Map<string, V>, key: string, value: V): void {
  if (map.size >= MAX_ENTRIES) map.clear();
  map.set(key, value);
}
const byHost = new Map<string, { at: number; org: HostOrg | null }>();
const verified = new Map<string, { at: number; ok: boolean }>();

/**
 * Forget every cached answer. Call it from every write that changes
 * `publicHost`, `publicHostVerifiedAt` or a slug (#1662's claim / verify /
 * release routes). Other replicas converge within the TTL.
 */
export function invalidateHostOrgCache(): void {
  byHost.clear();
  verified.clear();
}

/**
 * The org `hostHeader` names, or null. A verified own domain first, then
 * `<slug>.<APP_ROOT_DOMAIN>`; an unverified domain is null. For branding, SSO
 * discovery and pre-login copy only — never for data scope (hostOrgRule.ts).
 */
export async function resolveOrgFromHost(hostHeader: string | null | undefined): Promise<HostOrg | null> {
  const host = normalizeHost(hostHeader);
  if (!host) return null;
  const now = Date.now();
  const hit = byHost.get(host);
  if (hit && now - hit.at < TTL_MS) return hit.org;

  const select = { id: true, slug: true, plan: true } as const;
  let org: HostOrg | null = await prisma.organization.findFirst({
    where: { publicHost: host, publicHostVerifiedAt: { not: null } },
    select,
  });
  if (!org) {
    const slug = slugUnderRootDomain(host, normalizeRootDomain(process.env.APP_ROOT_DOMAIN));
    org = slug ? await prisma.organization.findUnique({ where: { slug }, select }) : null;
  }
  remember(byHost, host, { at: now, org });
  return org;
}

/**
 * Which of `candidates` are tenant domains whose ownership is proven — the
 * database extension of servedHosts() (src/lib/servedHosts.ts). The result is
 * passed as `extraHosts` to the redirect and SSO origin checks, so a browser
 * that started on a verified tenant domain is sent back there and an
 * unverified one never is. Asked per candidate host (the one host a redirect or
 * a RelayState names), so a domain verified a second ago is honoured as soon
 * as its own cache entry — never anybody else's — expires.
 *
 * A failed lookup answers "not verified": the redirect then falls back to the
 * configured origin, exactly as before this column existed.
 */
export async function verifiedTenantHosts(...candidates: (string | null | undefined)[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const raw of candidates) {
    const host = normalizeHost(raw);
    // A host the env already serves needs no database round trip.
    if (!host || servedHosts().has(host)) continue;
    const now = Date.now();
    const hit = verified.get(host);
    let ok: boolean;
    if (hit && now - hit.at < TTL_MS) ok = hit.ok;
    else {
      try {
        ok = !!(await prisma.organization.findFirst({ where: { publicHost: host, publicHostVerifiedAt: { not: null } }, select: { id: true } }));
        remember(verified, host, { at: now, ok });
      } catch {
        ok = false;
      }
    }
    if (ok) out.add(host);
  }
  return out;
}
