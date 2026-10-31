## 2026-10-31 — merging a four-PR hiring stack after squash merges (#1765, #1865, #1867, #1870; #3427, #3438, #3447, #3451, #3483)

- **After a squash merge, merge the lower PR's last head into the next branch first, then main.**
  Merging `origin/main` straight into `feat/1867-employer-page` right after #3438/#3447 were
  squashed produced ten conflicting files: git cannot see that main already holds the lower
  branch's commits. `git merge origin/<lower-branch>` (its final pushed head, which matches the
  squash tree) first, then `git merge origin/main`, left three real conflicts.
- **`git checkout --ours <file>` during a merge takes the WHOLE file and silently drops main's
  clean changes in it.** It erased other PRs' i18n keys and a route-auth baseline entry. Resolve
  per hunk instead (`git merge -X ours` only picks a side in conflicting hunks), and always check
  `git diff origin/main HEAD -- <file> | grep '^-'` before committing a resolution.
- **`-X ours` still loses main's side of a hunk that both edited.** Two different imports on
  the same line meant main's `notifyEvent` import vanished and tsc failed. Replay the merge
  without `-X` in a scratch worktree (`git worktree add --detach <dir> HEAD^1 && git merge
  origin/main`) to list exactly which hunks it decided, and fix those by hand.
- **The backfill registry is a shared append point.** Two PRs both added the next id
  (`0036-…` on main, `0037-…` here); keep both entries in id order and re-check that the id
  you claimed is still free after every main merge.
- **A `next build` OOM at the 4 GiB heap is the tree's size, not the PR.** Three e2e jobs died
  in "Build app" at ~4050 MB while the same commit built locally; a re-run would OOM again.
  It was fixed for everyone by raising the build heap (#3488); merge main rather than re-running.
- **A `page.goto` timeout on a first local e2e run is usually a cold `next dev` compile.**
  Warm the route (`curl` it) and re-run once before treating it as a regression.
- **`npm install` in the container can rewrite `package-lock.json` and redden
  `check:licenses`.** Use `npm ci`, and `git checkout package-lock.json` if it changed.
  `check:demo-fidelity` needs `npm run seed:demo` against a local DB; CI's job covers it.
