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

## Host → org resolution in the app (#1661)

The plumbing is in place; the claim/verify screens are #1662.

- **The column is `Organization.publicHost`** — the one explicit host mapping
  the schema already had (#2569) — plus `publicHostToken` (the value the
  customer puts in a DNS TXT record) and `publicHostVerifiedAt`. There is no
  second `customDomain` column: one host, one tenant, one `@unique`.
- **`resolveOrgFromHost(host)`** (`src/lib/hostOrg.ts`, rule in
  `src/lib/hostOrgRule.ts`) answers `{ id, slug, plan }` or `null`:
  1. a `publicHost` equal to the host **and verified** (`publicHostVerifiedAt`
     set) — an unverified claim resolves to nobody;
  2. `<slug>.<APP_ROOT_DOMAIN>` — exactly one label under the root, only while
     `APP_ROOT_DOMAIN` is set (`.env.example`);
  3. otherwise `null`, so the product's own hosts are unchanged.
  Answers are cached for 60 s per process; `invalidateHostOrgCache()` is called
  by every write that changes a mapping.
- **What a resolved host may decide:** branding, SSO discovery, pre-login copy.
  **Never data scope** — a signed-in request's org is its session's
  (`resolveOrgId`, which reads no header). `e2e/host-org.spec.ts` pins that a
  forged `X-Forwarded-Host` naming another tenant's verified domain changes
  nothing an admin reads.
- **Redirects and SSO hand-offs.** A verified tenant domain is a served host:
  `verifiedTenantHosts()` is passed as `extraHosts` to `resolveRedirectTarget`
  (NextAuth's `redirect` callback), `requestOrigin` (the SSO login route) and
  `servedOrigin` (the ACS's RelayState), still by **exact** match. A
  `<slug>.<APP_ROOT_DOMAIN>` host is **not** added — that would be a suffix
  rule (`src/lib/servedHosts.ts`, "One served-host allowlist" in CLAUDE.md).
- **E-mail links do not follow a tenant domain yet.** `appOriginForOrg()` still
  serves a `publicHost` only when it is in the env-derived `servedHosts()` — a
  verified DNS record proves ownership, not that our proxy answers on that host
  with a certificate. Pointing mail at the tenant domain is part of the
  onboarding checklist (#1662), not of this plumbing.
- **SAML identifiers** (`spEntityId`, `acsUrl`, `metadataUrl`, `sloUrl` in
  `src/lib/ssoSaml.ts`) take an explicit base origin, defaulting to
  `NEXTAUTH_URL`'s, so a tenant on its own domain can register that domain's
  identifiers without breaking any existing IdP registration.

**Server work, not done in the app:** subdomain tenancy needs a wildcard DNS
record (`*.<APP_ROOT_DOMAIN>`) and a wildcard certificate on the Caddy ingress
(DNS-01), and each customer domain needs its own site block with automatic TLS.
Those are operator steps on the host (`infra/README.md`), and step 3/4 above
still describe the retired Plesk host.
