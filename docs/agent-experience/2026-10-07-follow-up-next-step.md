# 2026-10-07 — follow-up chips + AI next step (#2875)

- **A nested worktree starts with a stale toolchain.** `npx tsc --noEmit` in a
  fresh `.claude/worktrees/<name>` reported ~15 Prisma-shape errors in files I
  had not touched, then two more (`qrcode` missing, a Playwright fixture type).
  All of it was the worktree's old `node_modules`: `npx prisma generate`, then
  `npm install`, and the tree typechecks clean. Do both before trusting a red
  `tsc`, and lint with `npx eslint --no-eslintrc -c .eslintrc.json <files>`
  (the main checkout's ESLint plugin copy collides with the worktree's).
- **`scripts/test/gitignore-exports.test.mjs` is red on this Mac on `main` too**
  ("a spreadsheet export anywhere in the checkout is ignored"), so
  `npm run test:unit:coverage` cannot evaluate its floor locally. Environment,
  not the change — verify by running the same file in the main checkout.
- **A unit test for a module that imports `@/…` values registers the resolver
  first**: `register('./ts-extensionless-resolve.mjs', import.meta.url)` and
  then `await import('../../src/lib/x.ts')` (the pattern in
  `org-starter-pack.test.mjs`). A plain static import fails on the alias. And
  never import a module that reaches `@/lib/ai/provider` (the SDK) from a unit
  test — put the shared constant in the dependency-free module instead.
- **New strings with an internship word need their MARKETING overlay in the
  same diff**, or `check:i18n` fails the leak ratchet. The `followUp.visibility`
  line ("…the mentee never does") got its "the contact never does" twin in
  `src/i18n/verticalOverlays.ts`, and the ratchet stayed at 414/417/412.
- **Local `next dev` under the 4-sign-in follow-up spec answers API calls in
  5–9 s each**, and the last `PUT /api/mentorship/[id]` of the spec never
  returned, so `expect(getByText('Follow-up saved'))` timed out at 15 s with
  every control still in its "saving" state. Read the trace's `*.network`
  lines (unzip `trace.zip`, filter `resource-snapshot` by URL) before blaming
  the change: the same PUT had already returned 200 twice in the run.
