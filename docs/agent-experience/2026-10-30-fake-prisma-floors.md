# 2026-10-30 — the last four AWAITING_TESTS modules floored (#1598)

- **Prisma-bound modules can run under the node runner without a DB**: `src/lib/prisma.ts`
  uses `globalThis.prisma` if it exists, so `installFakePrisma()` (scripts/test/fake-prisma.mjs)
  before the dynamic import routes every model call to a recorder. A Proxy per model answers
  any op; defaults keep untouched code paths (e.g. `resolveStartStage` with no org stages)
  falling back to the built-in pipeline.
- A Prisma **middleware** is testable the same way: the fake records `$use(fn)`, so the test
  calls `fn(params, next)` directly inside `runWithOrg(…)` and inspects what `next` received.
- `check-unit-coverage.mjs` goes RED the moment an AWAITING module is exercised and names the
  floor to write; move it to FLOORS and lower `EXPECTED_AWAITING` in the same diff.
- `process.env.MT_ENFORCE_ISOLATION` is read per call (`isIsolationEnforced()`), so a test can
  set it before importing and flip it inside one case (restore it in `finally`).
