# 2026-10-30 — searchable person picker (#1437)

- **Picking a perf story**: the issue search via `gh` is GraphQL (blocked) and `search/issues` is
  not repo-scoped (blocked). Instead, list `repos/<o>/<r>/issues?state=open&per_page=100&page=N`
  over REST and grep the titles. The MCP `search_issues` semantic search returned nothing for
  perf terms.
- **Replacing a `<select>` with a combobox breaks every spec that `selectOption`s it.** Grep
  `e2e/` for the label and the dialog's `locator('select').nth(n)` before you push.
  `e2e/helpers/personPicker.ts` (`pickPerson`) is the replacement step.
- **Local e2e against the default org is slow once the DB has piled up rows from earlier runs.**
  `/admin/candidates` was still "Loading…" after 10 s, and `group-relations` hit its 60 s timeout
  on main too. Before blaming a change, check the same spec on main with `git stash -u`. Specs
  that seed their own organisation are not affected.
- `fillTemplate()` returns nodes, so it can render a `{shown} of {total}` line straight into JSX.
