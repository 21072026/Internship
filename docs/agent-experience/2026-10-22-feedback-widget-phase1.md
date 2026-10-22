## 2026-10-22 — in-app feedback widget, phase 1 (#3130, epic #3129)

- **The route-auth and OpenAPI analysers only follow a guard inside the route file.** A shared
  `requireAdmin()` imported from `src/lib/…` made `check:route-auth` and `check:openapi` classify
  four `/api/admin/*` handlers as "public". Keep `getServerSession(authOptions)` + the role check
  in a function of the same file; a lib helper may resolve the org, not decide the access.
- **`check:hardcoded-strings` flags even a unit like `"ms"` in JSX.** Put it in the dictionary
  (`durationValue: '{ms} ms'`).
- **The shared local `internship_e2e` DB drifts with other sessions' schemas.** `db push` failed
  with "Cannot drop index … needed in a foreign key constraint". The `e2e` MySQL user cannot
  create databases, but the OS user can over the socket: `mysql -e "CREATE DATABASE x; GRANT ALL
  ON x.* TO 'e2e'@'127.0.0.1'"`, then `db push` + `db seed` into a database of your own.
- **The first `playwright test` after a fresh worktree times out in `signInAndSettle`.** The cold
  `next dev` compile exceeds its 20 s `waitForURL`; the second run (warm `.next`) is the real result.
- **`gitignore-exports.test.mjs` fails locally on macOS on an untouched checkout** — not a
  regression signal for `test:unit:coverage` on this machine.
