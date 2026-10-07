# 2026-10-07 — smoke grep isolation, lint inside a nested worktree

- **`--grep @smoke` runs a tagged test without its serial siblings.** In a
  `test.describe.configure({ mode: 'serial' })` file, the smoke gate runs the
  `@smoke` test alone: `beforeAll` still runs, but state the earlier tests
  set up (consent granted, rows created) does not exist. The full file was
  green ×3 locally while the smoke shard was red. A `@smoke` test must set up
  everything it needs itself (idempotently: `upsert`, not `create`). Verify
  with `npx playwright test <file> --grep @smoke`, not only the whole file.
- **ESLint in `.claude/worktrees/<name>` cascades into the main checkout's
  `.eslintrc.json`** (no `"root": true`), and fails with "couldn't find the
  config next/core-web-vitals" when the main checkout has no `node_modules`.
  Lint the changed files with the worktree's config only:
  `npx eslint --no-eslintrc -c .eslintrc.json $(git diff --name-only origin/main -- 'src/*.ts' 'src/*.tsx')`.
- **`auto-meet-link.spec.ts:191` fails locally when `BASE_URL=127.0.0.1`
  but `NEXTAUTH_URL=localhost`**: the "own host" refusal compares against
  `NEXTAUTH_URL`. Environment-only; it is green in CI.
