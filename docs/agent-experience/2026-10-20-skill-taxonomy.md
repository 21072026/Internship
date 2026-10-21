## 2026-10-20 — canonical skill taxonomy, epic #1810 (#2997, #3001, #3013, #3018, #3024, #3031)

- **`releases/unreleased/*.json` `notes` values are ARRAYS of strings, one per highlight, never a
  bare string.** A string makes `next.config.js` throw inside `resolveRelease()`, and that takes down
  lint, build, every smoke shard and the image build together, which looks like five unrelated
  failures. Run `npm run check:release-fragments` before every push, not only on the first PR.
- **"Lint · Typecheck · Build" is not a required check, so auto-merge goes ahead even when it is red.**
  Before pushing, run the `ci.yml` script list yourself:
  `grep -oE "npm run [a-z:0-9-]+" .github/workflows/ci.yml | sort -u`. With MySQL up and the env
  sourced, the whole list takes a few minutes.
- **The deploy runs backfills as `node prisma/*.mjs` in the Node 20 image, which has no
  TypeScript.** So TS data or rules they need get a plain-ESM copy plus a mirror test:
  `prisma/skill-taxonomy-lib.mjs` and `prisma/skill-seed.json` (from `npm run skills:seed-json`),
  pinned by `scripts/test/skill-taxonomy-mirror.test.mjs`. That is the same split as
  `skill-split.mjs`.
- **Topic and demo environments only run the backfills listed in `infra/server/topic-deploy.sh`
  and `demo-refresh.sh`, not `deploy-prod.sh`.** A feature that reads backfilled rows looks empty on
  `pr<N>.interncrm.com` until the backfill is added there too.
- **A Playwright spec can import server libs only statically.** `await import('../src/lib/x')`
  inside a test fails with `Cannot find module '@/lib/prisma'` because the alias does not resolve
  there; a top-level `import` does resolve.
- **Never sync join rows to the global `prisma` client from inside an interactive `$transaction`
  that wrote the parent row.** The FK insert waits on that transaction's own row lock until it
  times out. Capture the data, then sync after the commit (`/api/requisitions/[id]`).
- **`pkill -f "next dev"` kills your own shell**, because the pattern matches the `bash -c` command
  line that contains it. Start `next dev` with `run_in_background` and a long timeout, and stop it
  by looking up its PID with `ps`.
- **Squash merges plus stacked branches:** when you merge `origin/main` into a branch stacked on a
  just-merged PR, you get add/add conflicts in files both sides created. If
  `git diff <old-branch> origin/main -- <file>` is empty, `git checkout --ours` is safe for those
  files.
- **Pre-existing, not caused by this work:** `e2e/requisitions.spec.ts:114` ("concurrent count
  PATCH allows one winner") fails locally under `next dev` on MySQL 8 with `origin/main`'s own
  route, too.
