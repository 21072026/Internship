# The bench (#1778)

"Not this term, but keep them." A person on the bench (`User.participantState =
'BENCHED'`) keeps their account, their profile and their existing pairings, and
can still sign in and read their own record. What changes:

- **Not offered.** The mentor matching pool (`mentorPoolWhere`), the cohort
  pass's mentee pool and the mentee-facing mentor directory leave them out.
- **Not assignable — refused server-side** (`409 mentor_benched`), never just
  hidden in a picker: direct assignment (`POST /api/mentorship`), request
  approval and the mentor's own accept (`decideMentorshipRequest()`), a
  published match round, a mentor offer, and a mentor adding a mentee themselves.
- **Not nudged.** The nudge engine (`segmentUserWhere`, the delivery re-check),
  the dormant check-in, the weekly-report reminder, the mentor digests, the
  ending-soon nudge and the mentor attention list skip them.

What a bench never does (`src/lib/bench.ts`, the one writer): it does not touch
`isActive`, does not stamp `sessionsValidFrom` (revocation — which must also call
`revokeAllTrustedDevices()`) and does not move `consentAt` (the retention clock).
An optional "write to them again on…" date goes through `joinPool()` and needs
the person's own pool consent.

Admin: `/admin/users` → *On the bench* tab, a Bench / Return control per row, a
checkbox bulk action, and **Re-invite the bench** — the existing re-engagement
message (`checkReEngagementReminders({ userIds })`) to benched people whose date
has come; idempotent through `reEngageNotifiedAt`. APIs:
`PATCH /api/admin/users/[id]/bench`, `POST /api/admin/users/bench`
(`userIds` or `cohortId` — the programme's mentees — at most 500),
`POST /api/admin/users/bench/reinvite`; all `user.write`, tenant-scoped.
