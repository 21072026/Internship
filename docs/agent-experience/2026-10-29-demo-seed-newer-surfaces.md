# 2026-10-29 — Demo seed for the newer surfaces (story #2061)

- **A story can have every sub-task closed and still owe work.** #2061 ("no empty screens, and
  stay that way") had both tasks closed, but a dozen surfaces shipped after them with no seed.
  `npm run check:demo-fidelity` only guards what its manifest names: a new tenant table is
  invisible to it until somebody adds an entry. Add the entry in the same PR as the feature.
- **`minRows: 0` entries are listed as "no coverage" even when the seed fills them.** Four
  #1419 rows were seeded and still reported as debt. When you widen the seed, raise `minRows`
  to `target` in the same diff (the manifest's own instructions say so).
- **Seed automation/nudge rules disabled.** Both default to `enabled: false` in the product; a
  seeded *enabled* rule would mail people the moment a topic environment's worker picks up an
  event. Run logs and send history are plain history rows, not executions.
- **Affiliate is a MARKETING-only capability** (`MARKETING_ONLY_CAPABILITIES` in
  `src/lib/verticals.ts`): its demo rows belong on the marketing tenant, never the internship one.
- **Editing `scripts/demo-fidelity.json` with `json.dump` reformats every compact `where`** —
  splice text instead, or the diff buries the real change.
