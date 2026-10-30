# 2026-10-30 — Mentor stage deadline (#1373)

- **Check an old issue's premise against later security decisions.** #1373 (2026-08) asked to let the
  mentor pick the relation's company and said "the API already allows it". #2613 later made
  `companyId`/`projectId`/`cohortId` ADMIN-only in `PUT /api/mentorship/[id]` on purpose
  (`src/lib/relationTargets.ts` explains what each grants). Re-opening it would have been a
  regression; ship the part that is still valid and raise the rest as a question.
- **Date inputs: commit on blur, not on change.** Typing a year digit by digit yields a valid
  `0002-…` value at every keystroke, so an `onChange` PUT writes garbage dates in between.
  Keep a draft in state and save on blur; Playwright's `fill()` + `blur()` drives it.
- The e2e reliability recipe still holds: `npm run build` + `next start -p 3000` in the background,
  tests with `BASE_URL=http://localhost:3000`.
