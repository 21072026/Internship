# 2026-10-30 — Round review & publish API (#1796, part 1)

- **"Reuse the creation path" meant extracting it first.** `POST /api/mentorship` held the guard,
  the create, the webhook, the decision record, the notices and both mails inline. They are now
  `createGuardedRelation(tx, data)` (inside the caller's transaction; throws `AlreadyMentoredError`)
  and `announceNewRelation()` (after the commit) in `src/lib/relationCreate.ts`. A third caller
  should use the pair, never copy the route body.
- **All-or-nothing publish:** the plan gate takes `adding = n` and refuses before any write; the
  guard throws inside the one transaction, so a mentee paired elsewhere between lock and publish
  rolls back the relations created earlier in the same loop. The e2e proves the rollback by
  asserting the first mentee's relation does not survive.
- **A decision's score can come from elsewhere:** `recordMatchDecision({ snapshot })` records the
  score the coordinator saw (the proposal, scored under the round's rule set) instead of
  re-scoring now. Without it a rule-set edit between pass and publish would rewrite history.
- **Swap capacity must count the round's reservations**, not only live relations — otherwise a
  swap can overbook the mentor the pass had filled.
- `pkill -f "next start"` from the agent shell kills the shell (exit 144); find the pid with
  `ps aux | grep next-server` and `kill <pid>` in its own command.
