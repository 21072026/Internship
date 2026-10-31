# 2026-10-30 — Stage entry gates (#1589)

- **`replaceStages()` deletes and recreates every stage row.** Any new column on
  `PipelineStage` is wiped by the next editor save unless `replaceStages()`
  carries it over by key — check that before adding per-stage config.
- **An apostrophe inside a single-quoted string in `openapi.json/route.ts`**
  produced 300+ parse errors from one line. Avoid `'s` in those descriptions.
- **A new `ApiErrorType` has three homes:** `API_ERROR_TYPES` (`src/lib/api/v1.ts`),
  the `ERROR_STATUS` record in `src/app/developers/page.tsx` (typecheck enforces it)
  and the prose of `docs/public-api.md`.
- **`missingRequirementsForUser()` reads the stages a person is in NOW.** To ask
  about the stage they are about to enter, use `missingRequirementsAtStage()`.
