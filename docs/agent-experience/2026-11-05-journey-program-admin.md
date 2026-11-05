# 2026-11-05 — Journey builder for programme admins (#3582)

- **Over-restriction hides in the same shape as a leak.** `requirePermission(p)`
  with no subject is tier-only: for an org admin it is too loose (#3576), for a
  PROGRAM_ADMIN it is a flat refusal (`unscoped_subject`). Grep for
  subject-less `requirePermission('program.` when touching programme routes;
  both bugs have the same fix — the programme as the subject.
- **One gate, a permission parameter.** `programGate(request, session, id,
  'program.read' | 'program.write')` serves both the cohort writes and the
  journey builder; a second copy of the tenant + grant + 404 logic would drift.
- **A Python regex over route files misses `{ request }` shorthand** next to
  `{ request: _request }`. Count the substitutions per file and grep for the
  old call afterwards.
