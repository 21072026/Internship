# 2026-10-27 — Mentor self-match limit (#1808)

- **Extending a shared pure rule safely: copy the old body into the test as the oracle.**
  `getMentorAvailability()` has ~10 callers; the "no context = identical" test loops over
  every capacity × count × preference combination and compares against a verbatim copy
  of the pre-change derivation, with and without the new inputs. Cheaper and stronger
  than auditing each caller.
- **Derive instead of adding a provenance column.** "Self-selected" was not recorded on
  `MentorshipRelation`; it is derivable from `MentorshipRequest.preferredMentorId` +
  status + the still-active pair. No backfill, no `db push` risk — the only schema change
  is one nullable `Int?`.
- **Adding a member to a string-union status** is caught by `tsc` only where a
  `Record<Status, …>` exists (the directory page); ternary chains silently fall through
  to the last branch. Grep for the literal values, not just the type.
- Issue said "#2003 must land first" for the CSV half — check: `MentorBookingPolicy` was
  already on main, so the import can write into it directly.
