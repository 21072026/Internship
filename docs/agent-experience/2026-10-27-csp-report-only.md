## 2026-10-27 — nonce CSP, report-only first (#1552)

- **Next.js takes the nonce from the REQUEST header**, and it accepts
  `content-security-policy-report-only` as well as the enforced one
  (`next/dist/server/app-render/app-render.js`). So a report-only rollout needs no change in
  any page: set the policy on the request in middleware and Next stamps its own scripts.
- **A nonced inline `<script>` hydrates with a warning** ("attributes … didn't match",
  `nonce="…"` vs `""`): browsers hide a parsed nonce from the DOM. `suppressHydrationWarning` on
  that element is the fix, and `e2e/security-headers.spec.ts`'s console-error test catches a missing one.
- **Check nonces in the served HTML, not the live DOM**: after load, Next inserts scripts that
  `'strict-dynamic'` trusts without a nonce, and `el.getAttribute('nonce')` reads `""` anyway.
- **A new public `/api/*` route touches three registries**: `scripts/route-auth-baseline.json`
  (insert textually; a JSON round-trip reformats the whole file), `isAllowlisted()` in middleware
  if unverified accounts must reach it, and `VERIFY_EXEMPT` in `scripts/openapi-generate.cjs`
  (`check:openapi` compares the two).
- **After `git fetch` onto a newer main, re-run `npm ci` and `prisma generate`.** A stale
  `node_modules`/client surfaces as tsc errors in files you never touched.
