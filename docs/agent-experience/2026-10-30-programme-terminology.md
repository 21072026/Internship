# 2026-10-30 — programme terminology on pages (#3400)

- **`pkill -f "next dev"` inside a chained Bash command kills the command itself** (its own
  command line contains the pattern) and the call exits 144 with nothing after it run. Run
  `pkill` in its own call, or match something only the server has (`next-server`).
- **`next dev` was too unstable for a long serial e2e file today** — recompiles mid-run gave
  `ERR_EMPTY_RESPONSE`, sign-in redirect timeouts and different failing steps on each run,
  on unchanged main as well. A production build (`npm run build`, then `npm run start` on
  :3000, which Playwright's `reuseExistingServer` picks up) gives a stable comparison.
- A programme binding for the page dictionary must come from the database (the viewer's own
  relation, or a route id checked against the caller's org), never from a query string — a
  vocabulary is display data, but letting a URL pick it would let anyone render another
  programme's words.
