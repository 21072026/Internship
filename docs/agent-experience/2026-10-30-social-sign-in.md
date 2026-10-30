# 2026-10-30 — Social sign-in (#1962)

- **Reuse a session door instead of writing one.** A verified external identity → `createLoginLinkToken()`
  → redirect to `/auth/magic/complete` gets every account rule of the `magic` provider for free
  (inactive/pending, enforced SSO, archived tenant, world, and the account's own TOTP). The `sso`
  provider is NOT a safe target for a non-tenant identity: it skips the user's second factor by design.
- **A route file may export only handlers** — a shared constant (`SOCIAL_STATE_COOKIE`) moved to the
  lib; `tsc` does not catch it, `next build` does.
- **The stub IdP's identity is fixed by its discovery URL query for SSO tenants**; for env-configured
  providers that URL cannot vary per test, so the stub got `POST /oidc/next` (one-shot next identity).
- **Extracting a generic core from an org-bound engine**: keep the org functions as thin adapters
  (`orgClient(org)`) so every existing caller and the SSO e2e stay untouched, then run the SSO OIDC
  specs as the refactor's regression net.
