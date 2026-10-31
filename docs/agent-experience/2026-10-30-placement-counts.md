# 2026-10-30 — Placement counts (#1504)

- **Check an old issue against the code before planning it.** #1504's first half (six copies of the
  HIRED set) had already been done by #1882's `outcomeStageKeys()`; only the kind/attribution
  filter was missing. Say so on the issue when claiming it.
- **Never start a second `npm ci` while one is running.** Two overlapping background runs (a
  worker restart plus a manual re-run) left `node_modules` deleted; the next build died with
  exit 127 and `npx next` tried to download Next 16. Wait for (or kill) the first, then reinstall.
