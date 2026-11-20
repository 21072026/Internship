## 2026-11-16 — provisioning decision record (#1970)

- **The issue snapshot predates the current authorization model.** Compare
  `src/app/api/admin/organizations/route.ts` and `docs/role-access-matrix.md`
  before repeating the August claim that any admin can write another org’s SSO.
- **Roster deprovisioning is narrower than the story title.**
  `docs/roster-feeds.md` limits it to tenant mentees, off by default, with a
  grace period and safety stops. Buyer copy must preserve those limits.
- **Trust copy already has a home.** Use `docs/trust/questionnaire-answers.md`
  for copyable answers and link the decision record instead of adding runtime
  dictionary keys to deliver a documentation task.
