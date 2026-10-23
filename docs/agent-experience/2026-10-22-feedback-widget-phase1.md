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

## 2026-10-23 — session replay, phase 2 (#3131)

- **A DOM-screenshot library and rrweb fight each other.** `modern-screenshot` appends a scratch
  `iframe#__SANDBOX__<uuid>` to `<body>` and fills it with one sample element per tag; rrweb records
  same-origin iframes, so every capture bloated the replay buffer until the Send button hung on
  "Sending…". Block it in rrweb (`blockSelector: 'iframe[id^="__SANDBOX__"]'`).
- **A zod `.regex().optional().default('')` judges its own default.** An omitted field fails the
  regex with a bare 400 — make the pattern accept `''` (`/^(…)?$/`).
- **On `next dev` the first POST to a route includes its compile.** A 10 s first report and a 0.5 s
  second one are the same code; measure the second before calling anything slow.

## 2026-10-23 — bug reports phase 3 (#3132)

- **Stacked PRs here are squash-merged, so the next phase must be re-based by content, not by
  history.** Merging `main` into a branch stacked on a squashed PR conflicts on every shared file
  (add/add). What worked: take `main`'s copy of each conflicted file and re-apply only this branch's
  own diff (`git diff <old-base> <tip> -- <files> | git apply -3`), then check that the remaining
  diff against `main` lists exactly the branch's own files.
- **`scripts/test/outbound-approval-rule.test.mjs` pins the exempt category set.** A new mail
  category that a human triggers to a lead is still held like `message`; widening the exemption
  means changing that test on purpose, with a reason.
- **A doc edit that replaces a heading with "new section + heading" must keep the heading** — the
  Phase 2 replay section swallowed `## Storage` and it shipped that way.
