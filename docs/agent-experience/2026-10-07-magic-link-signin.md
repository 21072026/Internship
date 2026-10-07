## 2026-10-07 — magic-link sign-in (#1959)

- **Playwright 1.63 wants a different directory layout than the preinstalled 1194 build.** The
  CLAUDE.md symlink trick (`chromium-1194` → `chromium-1243`) is not enough: 1.63 launches
  `chromium_headless_shell-<rev>/chrome-headless-shell-linux64/chrome-headless-shell`, while the
  old build ships `chrome-linux/headless_shell`. Add the inner link too:
  `mkdir -p …/chromium_headless_shell-1194/chrome-headless-shell-linux64 && ln -s
  ../chrome-linux/headless_shell …/chrome-headless-shell-linux64/chrome-headless-shell`
  (and `chrome-linux64 → chrome-linux` under `chromium-1194`). API-only specs pass before
  this; anything that opens a page fails with "Executable doesn't exist".
- **`npm run check:schema-push` compares against `origin/main` by merge-base**, so it only
  works after the first fetch; in a fresh `--depth 1` clone of `main` that is already there.
  `git stash` is not needed to run it — it reads the working tree.
- **A hashed token table cannot be read back in an e2e, so seed the row through the app's own
  hash helper.** `e2e/magic-link.spec.ts` imports `hashLoginLinkToken` from the dependency-free
  `src/lib/magicLinkToken.ts` (the same split as `totp.ts` / `grantSpend.ts`) and verifies the
  request half through the row the API writes (`usedAt`, hash shape, TTL) instead of the mail.
  Keep the pure half importable from `e2e/` — pulling `@/lib/prisma` into it would drag the
  app's PrismaClient and tenant middleware into every worker.
- **Next 15.5 has a stable `after()` in `next/server`** and nothing in the tree used it until
  now. It is the right tool for "respond first, send the mail second" on an enumeration-safe
  endpoint; the dev server logs the deferred send (`Email not sent: SMTP is not configured`)
  *after* the 200 is already out, which is what the test log shows.
- **Extracting a block out of a NextAuth `authorize()` into a shared function is safe when it
  only reads `user`, `email`, `ip`, `origin` and `credentials.<field>`.** The TOTP/recovery step
  of the credentials provider was 150 lines; moving it to `requireSecondFactor()` verbatim and
  calling it from two providers kept `e2e/two-factor*.spec.ts` green without a change.
- **Apt on this image needs `apt-get update` first** — `mariadb-server` is "unable to locate"
  until then (docs/security-audit-playbook.md says so; it is easy to skip).
- **Under `next dev`, `e2e/auth.spec.ts:21` fails on a strict-mode violation that CI never sees:**
  `button[aria-haspopup="menu"]` also matches the "Open Next.js Dev Tools" button. CI runs
  `npm run start`, where that button does not exist. Not a regression signal; a local run of
  that spec needs a production server (or `getByTestId('account-menu-button')`).
- **The seeded admin is a prerequisite for `e2e/auth.spec.ts`**, not just for the app:
  `npx prisma db seed` after `db push`, or the two `admin@example.com` tests time out on
  "Invalid email or password".
- **Two cookie-less NextAuth requests in flight at once mint two CSRF cookies, and the sign-in
  POST then fails silently.** The CI trace showed the sign-in POST carrying csrf token A in its
  body (from `/api/auth/csrf`, sent with cookie A) while the cookie jar held B. NextAuth answers
  `/api/auth/signin?csrf=true` — a URL with **no `error` param**, so `signIn({ redirect: false })`
  returns `{ ok: true, error: null }` and there is no session. Two lessons: (1) a page that calls
  `signIn()` on mount should wait for `useSession().status !== 'loading'`, so the
  SessionProvider's first round-trip has landed and every later call reuses its cookie;
  (2) **in a spec, `page.request` shares the browser's cookie jar** — an `expect.poll` on
  `/api/auth/session` fired right after `page.goto` is exactly such a concurrent cookie-less
  request, and in the CI trace the browser's only csrf-setting response was the session GET, so
  the second cookie came from the test itself. Wait for the landing (`page.waitForURL('/portal')`)
  and read the session after. Only the production build (fast responses) interleaved them;
  `next dev` never did. `/auth/sso/complete` and `/auth/resume` share the page-side half (#2858).
- **Read a Playwright HTML-report artifact without a browser:** the report is a base64 zip in
  `<template id="playwrightReportBase64">`; `report.json` + per-test JSON give errors and
  attachment paths, `data/*.md` are the error-context snapshots and `data/*.zip` the traces —
  `*.network` inside a trace lists every request with cookies and set-cookie headers, which is
  what settled this one. Artifact names are zero-based (`playwright-report-0-smoke` = shard 1/2).
