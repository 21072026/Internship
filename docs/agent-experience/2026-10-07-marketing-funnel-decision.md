## 2026-10-07 — marketing backlog: BCC-to-CRM, usage signals, funnel decision #2572 (#2809, #2815, #2448, #2449, #2840–#2845)

- **A research subagent reads main at one moment; main moves under it.** Its triage said #2612
  (marketing on PR envs) was open and unbuilt — #2831 had merged ten minutes earlier and
  closed it. Re-check `git log origin/main -S'<key string>'` and the issue state before
  acting on, or asking the user about, anything a delegated audit reported.
- **Merged PR + extra commits on the same branch = the extras are stranded.** Auto-merge
  fired while later commits were still being pushed to the PR branch; GitHub merged the head
  it had. After every merge, `git rebase --onto origin/main <merged-head-sha>` and open a new
  PR for what is left — `pull_request_read get` (merged / head sha) tells you which commits made it.
- **A new `previousRelationId` meaning silently changes every chain reader.** The win-back link
  reused the transfer link, so `relationChains`/`foldChains` would have folded a churn and its
  return into one journey. Grep every reader of a link column (`relationChains`, `foldChains`,
  `companyDetail` chain) when you give the link a second meaning.
- **`trial-window-writers.test.mjs` is a per-file heuristic:** a route whose only
  `pipelineStatus` is the `where` of an `updateMany` still counts as a stage writer. Add a
  reasoned `EXEMPT` entry rather than reshaping correct code.
- **Local e2e without the seeded `admin@example.com` fails sign-in with a bare `waitForURL`
  timeout.** CI seeds it; locally run `SEED_ADMIN_EMAIL=admin@example.com
  SEED_ADMIN_PASSWORD='ChangeMe123!' npx prisma db seed` first. A spec that creates its own
  org-less ADMIN (as `trial-reminders-job.spec.ts` does) avoids the dependency.
- **`check:demo-fidelity` needs a clean DB:** a DB polluted by e2e runs fails `seed:demo` on
  unique keys. Create a throwaway database, `db push`, seed, check — and when a change lowers a
  floor on purpose, lower `minRows`/`target` in `scripts/demo-fidelity.json` in the same diff.
