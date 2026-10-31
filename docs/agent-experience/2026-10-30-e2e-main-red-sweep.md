# 2026-10-30 — main-red sweep (smoke + e2e-full)

- **Playwright resolves `@/` only while it loads the spec.** A `src/` module first
  reached later (a lazy `await import()` inside app code, e.g. emailService →
  emailRender) fails with `Cannot find module '@/…'` from *its* imports. Fix in
  the spec: import that module up front so the lazy import hits the cache.
- **A shared builder that grows a field breaks every Prisma `create` that spreads
  it.** `buildSupportAttachments()` gained `altText`; the feedback report spread it
  into `SupportReportFile`, which has no such column → 500. Grep the spreads
  (`...a`) when you add a field to a shared builder.
- **A panel added at the top of a page pushes rows below the fold**:
  `toBeInViewport()` does not scroll. Scroll the target first, then assert what the
  test actually means (here: not clipped horizontally).
- `node --experimental-strip-types` CLIs: no TS parameter properties, and a bare
  `./x` next to an `x/` folder needs the loader in
  `scripts/test/ts-extensionless-resolve.mjs` to prefer `x.ts`.
- Under `CI=1`, Playwright serves the existing `.next` (`npm run start`). Rebuild it
  before judging a server-side failure, or you are testing a stale build.
