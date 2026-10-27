# 2026-10-27 — Hiring card on the candidate page (#1398)

- **Reuse the scope rules; do not write new ones.** `visibleApplicationsWhere()` and `interviewRequestActorWhere()` already answer "which rows may this actor see" for applications and interview requests. Only `CompanyInterest` needed its own small rule. It has no `orgId`, so ADMIN scopes it through `company: { orgId }`.
- **Hide a card when its module is off, don't show an error.** `/admin/candidates/[id]` also exists in the MARKETING world. When the route answers `403 { code: 'capability_unavailable' }`, the client returns `null`. Treating it as "failed" would show an error on every MARKETING candidate.
- **A long client page fires many fetches at once on a cold `next dev`.** The relation panels go first, so the card's own fetch can start after the default 15 s `expect` timeout. Give the first assertion `{ timeout: 60_000 }`. Before blaming the component, probe with a small Playwright script that logs `/api/` responses. That showed the card was fine.
- **`next dev` restarts itself now and then** (`ERR_CONNECTION_RESET` mid-run). Curl the routes to warm them again, then re-run. It is not a test failure.
- **After `origin/main` moves, run `npm ci --ignore-scripts` + `prisma generate` again.** A stale `node_modules` gave `tsc` errors in files this change never touched (`ssoMetadata.ts`, e2e `StageSla` keys).
