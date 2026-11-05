## 2026-11-05 — Mentee owner's team and weekly meeting (#2272)

- **`Write` on a path that already exists overwrites it silently — check with `ls` first.** I
  named the new Prisma loader `src/lib/projectTeam.ts`, which is the existing `mergeTeam()` /
  `isProjectMember()` module; the tool reported "updated", not "created". `git checkout` restored
  it and the loader became `projectTeamAccess.ts`. The `*Rule.ts` (pure) + `*Access.ts`
  (Prisma) pair is the naming that avoids the clash.
- **Make the picker and the write call the same function.** `GET …/members/candidates` filters
  every row through `addableSeats()`, the call the member POST makes through
  `memberAddRefusal()` — so "the list offered" and "the set accepted" cannot drift. An admin's
  picker stays `/api/users`: a second listing for admins would have bypassed the PROGRAM_ADMIN
  grant scope that route applies.
- **Turning 403 into 404 moves assertions in specs you did not write.** `cross-tenant-projects`
  (foreign user → was 400), `project-members` (another mentor's mentee → was 403) and
  `project-mentee-owner` (`mentee_owner_invite`) all pinned the old answer; grep the route path
  across `e2e/` before running anything. A team member who is not a manager still gets 403 —
  they already know the project exists, so the 404 would hide nothing.
- **A `*.unit.spec.ts` run alone still boots the dev server** unless `BASE_URL` is set:
  `BASE_URL=http://localhost:3000 npx playwright test e2e/x.unit.spec.ts` finishes in seconds.
