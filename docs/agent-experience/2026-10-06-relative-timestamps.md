## 2026-10-06 — past timestamps as "5 dk. önce", the date on hover (#2813)

- **A Playwright `*.unit.spec.ts` cannot render a `.tsx` component.** Playwright compiles the
  JSX of every imported `.tsx` into its own component-test objects (`{ __pw_type: 'jsx', … }`), so
  `renderToStaticMarkup(<Comp/>)` throws "Objects are not valid as a React child". Importing a
  plain function from a `.tsx` still works (`e2e/json-ld.unit.spec.ts`). Keep a helper you want to
  unit-test JSX-free (`createElement` in a `.ts`, like `src/components/ui/fillTemplate.ts`) and
  pin the element itself in a browser spec.
- **`suppressHydrationWarning` keeps the SERVER's text, it does not fix it.** For anything that
  depends on "now" or the viewer's zone, React assumes the hydration render matches the DOM and
  never patches it, so a cached "5 min ago" stays until the next state change produces a
  *different* string. `<RelativeTime>` keys its `<time>` on a `useSyncExternalStore` hydration
  flag (server snapshot `false`): the first client render remounts the node with client values.
- **A fresh worktree's `node_modules` carries a stale Prisma client.** `npx tsc --noEmit` reported
  131 errors, none in the changed files (`aiArtifact`/`mentorBookingPolicy` "does not exist").
  Run `npx prisma generate` in the worktree first. This worktree's `node_modules` is a real
  directory, so regenerating it does not touch the main checkout.
- **ESLint in a worktree:** `npx eslint --no-eslintrc -c .eslintrc.json --resolve-plugins-relative-to . <files>`
  (the parent checkout's `node_modules` otherwise loads `@next` twice). Feed the file list with
  `xargs < list.txt`: zsh does not word-split `$FILES`.
- **`scripts/test/gitignore-exports.test.mjs` fails on macOS** ("accounts.CSV must be ignored"),
  because the filesystem is case-insensitive. It is green on the Linux runners and is not a
  regression.
- **Parallel agents in one worktree work if every agent owns distinct files and runs no
  project-wide tool.** 28 agents converted and re-verified 136 files with no conflicts. tsc and
  lint ran once, centrally, at the end. The verifier pass caught real slips: a spec comment that
  promised "N days ago" where the month rung applies, and a sentence whose German form
  ("Zuletzt gesendet am {date}") cannot take a distance.
