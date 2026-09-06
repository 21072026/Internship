# Per-tenant custom domains (white-label) — #546

How to serve a tenant (Organization) on its own domain — e.g.
`careers.acme.com` instead of `interncrm.com` — as part of the white-label track.
This is an **operator runbook**; the app change it depends on (Host → org
resolution) is gated behind the multi-tenancy rollout and is described at the end.

## Where we are

- The app already resolves a request's tenant from the signed-in user's `orgId`
  (`resolveOrgId`, #543). Custom domains add a second resolution path: map the
  **request Host** to an org, so even the pre-login pages (sign-in, SSO entry)
  and the branding/SSO config load for the right tenant.
- Wildcard TLS + reverse-proxy routing is already solved for the per-PR topic
  previews (`*.interncrm.com`, acme.sh wildcard cert, Plesk `vhost_nginx.conf`
  reverse proxy — see `infra/README.md`). A customer's **own** apex/subdomain
  needs its own certificate and a DNS record they control.

> **Stale since the 2026-09 server migration (#2166):** steps 3 and 4 below describe
> the retired Plesk host. Ingress is now Caddy on `s.interncrm.com`, which issues
> certificates itself; the routing half of this runbook still needs rewriting.

## Operator steps to onboard a custom domain

1. **Pick the tenant + domain.** Confirm the Organization exists and note its
   `slug` (Admin → Organizations).
2. **DNS (customer side).** The customer creates a `CNAME` from their host
   (`careers.acme.com`) to our ingress host (e.g. `interncrm.com`), or an `A`/`AAAA`
   record to the server IP for an apex domain (apex can't CNAME — use ALIAS/ANAME
   or A records).
3. **TLS certificate (our side).** Issue a cert for the customer domain. On the
   Plesk host, the simplest is a Plesk subscription/subdomain for the customer
   domain with a Let's Encrypt cert (`plesk bin subdomain --create` +
   Plesk → SSL/TLS → Let's Encrypt), or an acme.sh HTTP-01/DNS-01 issuance. Store
   the fullchain + key where nginx reads them.
4. **Reverse proxy.** Point the customer vhost at the app container via
   `vhost_nginx.conf` (`location ~ ^/.* { proxy_pass http://0.0.0.0:<port>; }`)
   and `plesk sbin httpdmng --reconfigure-domain <domain>` — the same pattern the
   topic-preview script uses. Preserve the `Host` header (default with
   `proxy_pass`), because the app resolves the tenant from it.
5. **Map the domain to the org.** Set the org's custom domain (see the app change
   below) so Host → org resolution knows `careers.acme.com` ⇒ that Organization.
6. **Verify.** Hit `https://careers.acme.com/api/health` (200 + version), then the
   sign-in page — it should show the tenant's white-label brand, and (if
   configured) the SSO entry.

## Security / operational notes

- **One cert per customer domain.** Never reuse the `*.interncrm.com` wildcard for a
  customer's own domain — it doesn't cover it and would fail validation.
- Keep `NEXTAUTH_URL` correct per environment. With multiple domains, cookies are
  host-scoped, so a session on `careers.acme.com` is independent from
  `interncrm.com` — which is the desired isolation.
- SSO ACS/SP identifiers are derived from the request base URL
  (`src/lib/ssoSaml.ts`); a tenant on a custom domain must register the ACS/SP
  values for **that** domain in its IdP.
- Custom domains do not require `MT_ENFORCE_ISOLATION`; they are an ingress/branding
  concern. Data isolation remains governed by the #543 rollout.

## The app change it depends on (Host → org resolution)

To fully activate custom domains, the app must resolve the tenant from the
request Host on **public** routes too (not just the session `orgId`):

1. Add a `customDomain` (unique, nullable) field to `Organization`, managed in
   Admin → Organizations.
2. Extend org resolution: given a request, if the Host matches an org's
   `customDomain` (or `<slug>.interncrm.com`), treat that org as the tenant — feeding
   `getOrgBranding`, the SSO entry, and (when enforced) `runWithOrg`.
3. Fall back to the current single-tenant/default behavior when no domain
   matches, so `interncrm.com` is unchanged.

This is intentionally a **later slice** (it only matters once multiple tenants
are live on their own domains); the runbook above is the ops half that is ready
now on the existing wildcard + Plesk reverse-proxy infrastructure.
