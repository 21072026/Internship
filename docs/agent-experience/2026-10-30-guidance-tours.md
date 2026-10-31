# 2026-10-30 — Tours and contextual help (#2067)

- Search the schema before you add a model. The issue asked for a new
  `UserGuidanceState`, but #2068 had already built it, along with
  `src/lib/guidance.ts`. Tours reuse it under `tour:<id>` keys, so there is no
  schema change.
- Anything that opens over a first page (a consent banner, a first-run tour)
  breaks every e2e spec unless the suite's storage state switches it off.
  `e2e/global-setup.ts` seeds localStorage for both origins. The project's
  `use.storageState` also reaches `browser.newContext()` (relative URLs prove
  it), so only specs that pass an empty `storageState` start clean.
- A modal that changes step without remounting needs its own focus move per
  step. `useModalFocus` focuses the first control once, when it opens.
