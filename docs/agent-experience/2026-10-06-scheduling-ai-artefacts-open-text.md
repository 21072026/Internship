## 2026-10-06 — scheduling guardrails, AI artefacts, open-text insights (#1995 #2001 #2003 #1999 #1997 #1912 #2044 #2046)

- **The cache key of `runAiGated` is the `scope` string, not the feature name.** `TASK_TTL_MS` was
  keyed `mentor_suggest` while the route runs as `scope: 'mentor_match'`, so the match rationale
  was silently never cached. When adding a TTL, grep the route's `scope:` value; a unit test that
  asserts `TASK_TTL_MS[<scope>] > 0` costs one line.
- **A custom parser that returns `null` must call `noteParseError()`** (`src/lib/ai/provider.ts`).
  Otherwise `runAiGated` meters `ok` and *persists* `"null"` as an artefact, and that answers every
  identical request for the TTL. `safeParseModelJson` does this for you; a hand-rolled verifier
  (e.g. `parseOpenTextSummary`) does not.
- **Any e2e whose result depends on "all mentors / all rows in the org" needs an org of its own.**
  The mentor-match cache hash covers the whole candidate pool and the insights hash covers every row
  in range; in the shared default org parallel workers change both mid-test. Pattern:
  `prisma.organization.create({ data: { name, slug } })` + `seedUser(..., org.id)` (see
  `e2e/admin-roi.spec.ts`, `e2e/open-text-insights.spec.ts`). Clean up `aiArtifact` by `orgId`
  before deleting the org.
- **To seed a cached AI result in e2e, import the route's own hash helper** (`hashInput`,
  `openTextInputHash`, `prepareOpenText`) instead of re-deriving the hash in the test. Playwright
  resolves `@/` imports, and a hand-copied hash drifts the first time the input changes.
- **A stacked PR whose base was squash-merged: compare before resolving.**
  `git diff <base-head-sha> origin/main -- <file>` empty ⇒ `git checkout --ours <file>` is exact;
  only files that main changed *after* the base (here `dictionaries.ts`) need a real merge.
  A regex that keeps the HEAD side of each `<<<<<<<` hunk resolves a pure rename quickly.
- **Public legal/transparency copy rots when a feature changes what is stored.** #2044 made
  generated text persistent but left the privacy notice saying "neither the text sent nor the text
  generated is stored" and `/ai` saying "five features". When a change touches storage or adds an
  AI scope, grep `aiBody`, `ai.intro`, `ai.retentionBody` and `e2e/ai-transparency.spec.ts`
  (it pins the task count and the ✨ surface list).
- **A cold `next dev` compile can blow a 10 s `toBeVisible`** on a page's first visit
  (`/mentor/mentees/[id]`, `/api/availability`). Re-run on a warm server before calling it a
  regression; it passed unchanged both times here.
