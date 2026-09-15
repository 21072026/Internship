// Host → vertical resolution for PUBLIC pages (#2355, epic #2348).
//
// A signed-in user's vertical comes from their organization (verticalContext).
// But the landing page and every other public page has no session, and the whole
// point of #2355 is that TWO urls serve TWO products from ONE deployment:
// interncrm.com shows the internship landing, marketing.ersah.in the marketing
// one. The only per-request signal a public page has is the Host header, so that
// is what decides the vertical there.
//
// Kept as a tiny, env-driven map rather than hard-coded hostnames: the marketing
// host is deployment configuration (it differs between prod, preview and a
// developer's machine), so it reads from MARKETING_HOSTS — a comma-separated
// list — and everything else, including a missing header, falls back to the
// default product. A host we do not recognise is INTERNSHIP, never a blank
// product, mirroring toVerticalKey's total-function contract.

import { headers } from 'next/headers';
import { DEFAULT_VERTICAL, type VerticalKey } from '@/lib/verticals';

// The hosts that serve the MARKETING landing. Comma-separated, matched on the
// hostname only (port and case ignored). Defaults to the known marketing domain
// so a deployment that sets nothing still routes it correctly.
function marketingHosts(): Set<string> {
  const raw = process.env.MARKETING_HOSTS ?? 'marketing.ersah.in';
  return new Set(
    raw
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

// Normalise a Host / X-Forwarded-Host value to a bare lowercase hostname.
export function hostnameOf(hostHeader: string | null | undefined): string | null {
  if (!hostHeader) return null;
  // X-Forwarded-Host can carry a list (proxy chain); the first is the client's.
  const first = hostHeader.split(',')[0].trim().toLowerCase();
  // Strip a port if present. IPv6 in brackets has none we care about here.
  return first.replace(/:\d+$/, '') || null;
}

// The vertical a given host serves. Pure, so it is unit-testable without the
// request headers.
export function verticalForHost(hostHeader: string | null | undefined): VerticalKey {
  const host = hostnameOf(hostHeader);
  if (host && marketingHosts().has(host)) return 'MARKETING';
  return DEFAULT_VERTICAL;
}

// The vertical for the current request's host. Reads X-Forwarded-Host first,
// then Host; any failure resolves to the default.
//
// TRUST NOTE (revised 2026-09-16). Every environment — prod, preview AND the
// per-PR topic envs — now sits behind Caddy (infra/server/topic-deploy.sh
// route_caddy; the nginx/Plesk passthrough this note used to describe was
// retired with the Plesk box on 2026-09-06 and is dead code). Caddy's
// reverse_proxy OVERWRITES X-Forwarded-Host with the host it accepted, so the
// value read here is the proxy's, not the client's. Even so, keep the contract:
// the host-resolved vertical is COSMETIC — copy, landing sections, chrome — and
// must not decide anything with cross-user weight (tenant scoping, roles, data
// access). The ONE permitted authz-adjacent use is /api/register refusing a
// token-less sign-up on a MARKETING host (#2356): its failure mode under a
// forged header is refusing the forger's own request, nothing else. Anything
// beyond that must key off a signal the request cannot influence (the session's
// org, the invitation row), never this header.
export async function hostVertical(): Promise<VerticalKey> {
  try {
    const h = await headers();
    return verticalForHost(h.get('x-forwarded-host') ?? h.get('host'));
  } catch {
    return DEFAULT_VERTICAL;
  }
}
