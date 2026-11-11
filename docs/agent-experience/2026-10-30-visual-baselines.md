# 2026-10-30 — Visual regression baselines (#1614, part 2)

- **Never commit screenshot baselines made in the agent container.** Font rasterisation differs
  from the GitHub runner. Generate them with `visual-baselines.yml` and review the PR it enables;
  locally, only prove the spec is stable (generate once, compare twice).
- **`next dev` dies under a 42-screenshot run here** (memory). `npm run build` + `npm run start`
  and `BASE_URL=http://localhost:3000` is both stabler and what CI actually runs.
- **A blanket `context.clearCookies()` drops the consent cookie** and puts the cookie banner into
  every screenshot. Clear only the session cookie (`clearCookies({ name: /session-token/ })`).
- **Determinism hazards found by looking at the PNGs, not by the diff:** nav count badges and the
  first-run checklist count rows other specs create in the shared shard DB. Mask them.
- **`schema-push-safety.test.mjs` fails in a shallow clone** (it diffs the parent of the #2249
  commit). `git fetch --unshallow origin` before running `test:unit` locally — CI uses
  `fetch-depth: 0`.
