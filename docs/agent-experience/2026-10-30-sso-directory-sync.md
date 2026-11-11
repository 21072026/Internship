# 2026-10-30 — SSO directory sync (#1943)

- **`completeSsoSignIn()` is the one hook for "on every SSO login".** Both the SAML ACS and the
  OIDC callback call it with full Organization rows, so widening its `org` type is a one-line
  change per caller (none needed: they pass `findUnique` rows).
- **A pure module may import another pure module only extensionless + relative**
  (`./orgAttributesRule`); its unit test registers `scripts/test/ts-extensionless-resolve.mjs`
  before the dynamic `import()`. `@/` aliases do not resolve under `node --test`.
- **The SSRF guard refuses a literal private IP without DNS**, so an e2e for "photo URL refused"
  can use `https://169.254.169.254/...` and stays offline and deterministic. The insecure-stub
  switch (`SSO_ALLOW_INSECURE_STUB`) covers only the OIDC endpoints, not `ssoFetch`; a positive
  photo case therefore uses inline base64 rather than a loopback URL.
- **Work that runs in `after()` needs `expect.poll` in the spec** — the ACS answers before it runs.
- **Schema edit by string replace: check the indentation of the anchor.** `prisma format` aligns
  User's columns with two spaces; a three-space anchor silently matched nothing and tsc was the
  first to notice.
- **`check:route-auth` only credits a guard called in the same file**, so a per-route
  `orgSettingsGate()` is duplicated by design rather than shared from `src/lib`.
