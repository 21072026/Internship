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
