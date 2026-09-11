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
// TRUST NOTE: on the Caddy front (prod) reverse_proxy overwrites X-Forwarded-Host
// with the real host, so it is authoritative there. On the nginx/Plesk topic
// path it is NOT stripped, so a client could forge it. That is acceptable ONLY
// because the resolved vertical is COSMETIC here — it drives the terminology
// overlay (landing copy, the "Candidates"→"Leads" label) and nothing else: a
// forged header just shows the forger marketing copy on their own request, with
// no authz, data-scope or cache consequence (capability/tenant decisions read
// the SESSION's org, never this host). If a vertical ever gains authz weight,
// host resolution MUST move to a signal the proxy is trusted to set (or a
// server-side host allow-list keyed off the TLS SNI), not this header.
export async function hostVertical(): Promise<VerticalKey> {
  try {
    const h = await headers();
    return verticalForHost(h.get('x-forwarded-host') ?? h.get('host'));
  } catch {
    return DEFAULT_VERTICAL;
  }
}
