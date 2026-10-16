## 2026-10-16: mail queue operations, alerts and the PR-environment sink (#2953, #2954)

- **`check:openapi` reads only the route file.** A route that delegates its ADMIN check to a
  helper in `src/lib/` is classified "public" or "any-session" and fails the check. Keep the
  `if (!session || session.user.role !== 'ADMIN') return …401` guard in the route file itself,
  and let the helper decide the finer scope.
- **A "retry from the screen" feature needs the payload to survive the terminal state.** The
  outbox used to clear the sealed envelope on every terminal state, so a dead mail could not be
  retried. Dead and failed rows now keep it until `notAfter`, and a once-a-minute sweep clears it
  after that. Check what a terminal settle throws away before you design an operator action
  on it.
- **Health detail has three trust levels, not two.** `detail` fails open, `verified` covers the
  token or any ADMIN, and `operator` covers the token or a super admin. Anything that shows the
  whole deployment's volume belongs at the operator level. A tenant ADMIN is verified, but must
  not read other tenants' mail counts.
- **Source-shape unit specs pin exact strings.** `e2e/job-queue-dlq-alert.unit.spec.ts` asserts
  literal lines of `src/app/api/health/route.ts`. If you change a return shape there, update the
  spec in the same commit.
- **Local smoke failures after a fresh database are usually the environment.** You need
  `npx prisma db seed` with `SEED_ADMIN_EMAIL=admin@example.com SEED_ADMIN_PASSWORD='ChangeMe123!'`
  (CI's values). Failed sign-ins before the seed leave `AccountLockout` rows that keep failing
  later runs with "Too many attempts". Delete those rows and run again.
- **On another port, `next start` needs `PORT` as well.** With `CI=1`, Playwright runs
  `npm run start`, which ignores the config's `const PORT`. Set `PORT=3100` in the environment
  together with the edited constant.
