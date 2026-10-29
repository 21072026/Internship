# 2026-10-29 — Public ROI calculator (#1755)

- **A new top-level `src/app/<dir>` needs a `layout.tsx` with `<I18nScope scope="<dir>">`** since #2987/#3224, and `npm run i18n:scopes` (or `npm ci`) to regenerate the gitignored manifest — otherwise `tsc` cannot even type the scope id.
- **"One model" with a new kind of input:** extend the model's input with an OPTIONAL field whose absence leaves every existing figure and step byte-identical (here `timeSaved`), and put the visitor-side mapping in the same module as a small adapter. The admin report's e2e (which asserts the step keys) stays green without edits.
- **Check `check:text-limits` when a schema PR adds a VarChar column** — #3185 added `Company.productPlan` and #3249 had to register it afterwards.
- **After a day away, re-check that nobody shipped the issue meanwhile** (`git log origin/main --grep`) and merge main before continuing a half-done branch; ~75 PRs had landed overnight.
