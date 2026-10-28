## 2026-10-27 — the client dictionary, shipped per segment (#2987)

- **The root layout cannot decide what a page needs.** App Router keeps the root layout across
  client navigations, so trimming the root's `LocaleProvider` dict by path would leave /features'
  trimmed dict in place after a client navigation to /admin. Segment layouts re-render with their
  segment, so the per-page part has to arrive there (`<I18nScope>`); the root carries only a shell.
- **Scan the client module graph, not every reachable file.** A first pass that collected `.ns`
  tokens from all files reachable from the root layout put 75 namespaces (181 KB) in the shell —
  `emailService.ts`, `notify.ts` and `settingsResolver.ts` all say `.notifications` / `.settings`.
  Only files at or below a `'use client'` boundary can call `useT()`; walking server files just to
  find those boundaries took the shell to 19 namespaces (34 KB).
- **The Docker build is Node 20 — no `--experimental-strip-types`.** A generator that `build` runs
  must be plain `.mjs` and must not import `dictionaries.ts`; it reads the namespace names from the
  `const en = {` block with a line regex instead.
- **Never commit a manifest that every PR changes.** The first version committed
  `scopes.generated.ts` and failed CI when it was stale; one merge of `main` (4 new namespaces
  from parallel PRs) made it stale at once. With ~10 sessions merging in parallel that is a
  conflict and a red check on every PR — the `agent-experience.md` lesson again. It is now
  gitignored and generated on postinstall / dev / build; CI checks only that scopes are mounted.
- **Measure before/after in the same mode.** `git worktree add <scratch>/base origin/main` plus a
  `node_modules` symlink runs main's `next dev` on a second port in under two minutes; both dev
  servers start with a dummy `DATABASE_URL`, and every public page except the Prisma-backed ones
  (/contributor-terms) renders. Dev-mode HTML is bigger than prod's, so quote the delta, not the
  absolute.
