## 2026-10-30 — the /admin/forms builder (#1802)

- **Look for an abandoned branch before writing a screen from scratch.** `git push` to
  `feat/1802-form-builder` was rejected: a 9-day-old WIP commit (no PR) already held the list page,
  the builder and `FormFieldInput`. Its one failing e2e step was a testid mismatch
  (`builder-version-badge` vs the page's `form-version-badge`). Salvaging it and rewiring it to the
  merged rule module (`builderRule.ts`) was far cheaper than a rewrite. Push the new work under a
  new branch name; never force over someone else's branch.
- **`pgrep -f "next dev"` inside a Bash call matches that Bash call itself** — killing the result
  killed the tool's own shell (exit 144). Use a bracket pattern: `pgrep -f "[n]ext dev"`.
- **`signInAndSettle` waits a fixed 20 s for the landing URL.** Under `next dev` a fresh admin's
  first `/admin` compile overruns it on this box. For a UI spec, `npm run build` once and run the
  specs against `next start` (Playwright reuses a server on :3000) — no compile on the first hit.
