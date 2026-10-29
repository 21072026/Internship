# 2026-10-29 — Free-core sweep of mentee-facing gates (#3270)

- **How to sweep for commercial bodies a participant can read:** grep the callers of every `*LimitError()` in `src/lib/planGate.ts`, every `feature_locked` producer, and `error:` strings matching `upgrade|plan limit|your plan` outside `src/app/api/admin`; then check each route's role guard. The AI gate is already neutral for participants (`aiGate` `participant` audience), so its `feature_locked` never reaches a mentee.
- **Keep the operator body for staff:** branch on `session.user.role === 'MENTEE'` at the gate rather than changing the shared error builder — the upgrade prompt (#1745) still reads `project_limit_reached` for ADMIN/MENTOR.
- **A participant-facing sentence must not say "mentor" either** — the MARKETING leak ratchet counts it even in the `projects` namespace.
