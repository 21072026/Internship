# 2026-10-30 — Editing an interaction log (#1356)

- **`next dev` can be the flake.** In this container the dev server grew to ~9 GB RSS at
  130 % CPU after a few specs, and browser specs timed out on page loads and on the first
  POST to a route (27 s compile) — on `main` as well as on the branch. The API itself
  answered in < 1 s when called directly. Before calling a spec red, probe the endpoint with
  `playwright.request` (no browser) and check `ps aux --sort=-%cpu`; for a stable run, build
  once (`NODE_OPTIONS=--max-old-space-size=8192 npm run build`) and point the specs at
  `next start` with `BASE_URL`.
- **An edit form that re-sends every field is a data change.** Logs created by other paths
  can carry a time of day; re-sending the date-input value (`YYYY-MM-DD`) would move them to
  midnight. Diff against the original and PUT only what changed.
- One zod shape for both the create and the edit route (`src/lib/interactionSchema.ts`)
  keeps them from drifting again — the edit schema had lost `subject` and three of the types.
