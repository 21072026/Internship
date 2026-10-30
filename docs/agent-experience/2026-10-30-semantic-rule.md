# 2026-10-30 — Semantic match rule, scoring half (#2038)

- **A new scoring input belongs in `pool.ts`'s select, not in a new loader.** Every scoring path
  (suggest, dry run, cohort pass, swap, decision record) reads people through `loadMentorPool` /
  `loadMentees` / `loadPairForScoring`; a relation select (`profileDigest: { select: { themes } }`)
  there reaches all of them in the same query, and the cohort pass's "each loader once" test stays
  true without touching it.
- **`applicable: false` is the safe default for optional data.** A weighted rule that is not
  applicable adds the same 0 to every candidate, so the order cannot move — that is what makes
  "works with AI off" true by construction rather than by a branch.
- **"Weight 0 reproduces the ranking byte for byte" holds in this scorer** because a weight-0
  rule adds nothing to `totalWeight`; prove it by comparing `[id, score]` with and without the rule.
- A dimension that must never block is enforced twice: the write schema refuses a hard kind, and
  the scorer reads a stray hard row as weighted (rows written before the refusal existed).
- `check:erasure-coverage` catches a new free-text column about a person; delete it in
  `accountErasure.ts` and list it as ERASED in the script in the same diff.
