// Which way a stage move goes (#2451) — the rule, dependency-free.
//
// WHY. A machine writer (the SaleVali ingest, a feed, an auto-advance) acts on
// events that can arrive late, twice, or out of order: a late `account_created`
// for a merchant who has since bought must not drag the record back to the
// trial. People are different — an admin moving a card back, or extending a
// trial, is a decision — so this rule is OPT-IN: only machine writers ask it,
// and a human move never goes through it.
//
// THE RULE, on the org's OWN resolved stages (never hardcoded keys — a tenant's
// pipeline is its own, #1884):
//   • to an OFF-PATH stage (lost, dropped): never backward — leaving the flow is
//     an exit, not a step back, and it is allowed from anywhere;
//   • FROM an off-path stage to an on-path one: backward — a machine never
//     reopens a closed record; the caller starts a NEW journey chained by
//     `previousRelationId` instead (the old record stays as it ended);
//   • both on the path: backward iff the target's `order` is lower;
//   • the same stage, or a stage this org does not have: not a backward move
//     (the first is a no-op, the second is the caller's validation error).
//
// Re-exported by src/lib/stageChange.ts, where every stage-write rule lives;
// unit-tested in scripts/test/stage-direction.test.mjs.

export interface StageForDirection {
  key: string;
  order: number;
  isOffPath: boolean;
}

export function isBackwardMove(stages: readonly StageForDirection[], fromKey: string, toKey: string): boolean {
  if (fromKey === toKey) return false;
  const from = stages.find((s) => s.key === fromKey);
  const to = stages.find((s) => s.key === toKey);
  if (!from || !to) return false;
  if (to.isOffPath) return false;
  if (from.isOffPath) return true;
  return to.order < from.order;
}
