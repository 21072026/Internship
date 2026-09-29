import { headers } from 'next/headers';
import { requestOrigin } from '@/lib/servedHosts';

// The absolute origin this deployment answers on.
//
// Needed by the two metadata routes that must emit *absolute* URLs (robots.ts's
// `Sitemap:` line and every `<loc>` in sitemap.ts) — a relative path is invalid
// in both formats. `NEXTAUTH_URL` is the one variable every environment already
// sets (it is required, see .env.example), which is why it is the source of
// truth here rather than a new SITE_URL nobody would remember to configure;
// `NEXT_PUBLIC_APP_URL` is accepted as the same second choice the SSO and email
// link builders make.
//
// Read at request time, never baked in: the Dockerfile takes no NEXTAUTH_URL
// build-arg, so a value resolved during `next build` would be localhost on
// every deployment. Both callers are therefore `force-dynamic`.
export function siteUrl(): string {
  const raw =
    process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  return raw.replace(/\/+$/, '');
}

// The origin of the host THIS request came in on (#2495), for robots.txt's
// `Sitemap:` line and every `<loc>`: one container serves interncrm.com and
// marketing.bcsit-gmbh.de, and the marketing host's robots.txt used to announce
// `Sitemap: https://interncrm.com/sitemap.xml` — the other product's pages.
// Validated against the served-host allowlist (#2488) by requestOrigin(), so a
// forged Host can only ever produce one of our own origins; a request with no
// usable host gets the configured origin, as siteUrl() always did.
export async function requestSiteUrl(): Promise<string> {
  const h = await headers();
  return requestOrigin((name) => h.get(name));
}
