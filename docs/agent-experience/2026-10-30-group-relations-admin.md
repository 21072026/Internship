# 2026-10-30 — Group relations, admin surface (#1804, slice 2)

- **A group is one relation with a pair, not N relations.** Building it on the
  shared create path (`createGuardedRelation`) for the first mentee and seats for
  the rest kept the guard, the mirror seats, the webhook and the decision record
  for free; the extra mentees only needed `announceNewRelation({ seat: true })`
  (no second `mentorship.created` for a relation that already exists).
- **Ask the invariant for every seat inside the transaction**, before the first
  write, so a refusal names the person in the way and nothing is half-created.
- **A new `type="search"` input fails `test:unit` (the VPAT 4.1.3 claim)** unless
  the component calls `useFilterAnnouncement`. Same trap as the earlier rounds UI.
- **A new i18n namespace with "mentor/mentee" words trips the MARKETING leak
  ratchet.** If its only screen is behind the `mentorship` capability, argue it
  into `LEAK_EXEMPT` (scripts/check-i18n.ts) rather than overlaying it.
- `check:notify` is red on main (emailService 61 vs 60 allowed) — not this PR's.
