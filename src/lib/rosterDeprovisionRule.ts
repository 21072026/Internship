// Roster-feed deprovisioning: the rules (#1966, docs/roster-feeds.md).
//
// "When HR removes someone from the feed, their access ends that night, without
// anyone doing anything." That is half of this file. The other half is
// REFUSING to: a truncated download, a wrong path or a bad column map looks
// exactly like "everyone left the company", and an automated system that
// believes it deactivates an organisation at 02:00. So the valves come first
// and the deactivation last, and everything here is pure — no Prisma, no clock
// of its own — so each valve is pinned by `e2e/roster-deprovision.unit.spec.ts`.
//
// THE VALVES (all hard requirements, all checked before a single write)
//   1. Row floor — a file with fewer data rows than `minRowCount` aborts the
//      whole run as ABORTED_SAFETY: no creates, no updates, no deactivations.
//   2. Ceiling — when the people the feed would offboard (now OR once their
//      grace runs out) exceed `maxDeactivatePercent` of the org's active people
//      the feed covers, the run aborts the same way and alerts. Counted on
//      everyone absent, not only on those due tonight, so a bad file is caught
//      on the night it arrives rather than one grace period later.
//   3. Grace — a person is deactivated only on a successful run at least
//      `deprovisionGraceDays` UTC calendar days after the run that first found
//      them absent (`rosterAbsentSince`). One bad night is never enough.
//   4. Never the last active admin of the org, never an `ssoExempt` account
//      (the break-glass door, #1950). Both refusals are reported.
//
// AND THREE THINGS IT NEVER DOES
//   - delete or anonymise: deactivation is reversible, erasure stays a human act;
//   - deprovision on a run that had a row ERROR: a row we could not read is a
//     person who looks absent, so the diff is not trusted (`canDeprovision`);
//   - reactivate somebody a human switched off: only `deactivatedBy` equal to
//     this feed's actor tag is undone by a file.

export const DEFAULT_MAX_DEACTIVATE_PERCENT = 10;
export const DEFAULT_MIN_ROW_COUNT = 1;
export const DEFAULT_DEPROVISION_GRACE_DAYS = 1;

/** The `User.deactivatedBy` value a feed writes — and the only one it undoes. */
export function rosterActor(feedId: string): string {
  return `roster:${feedId}`;
}

export interface DeprovisionSettings {
  feedId: string;
  deprovision: boolean;
  maxDeactivatePercent: number;
  minRowCount: number;
  deprovisionGraceDays: number;
}

/** One person the feed covers, as the deprovisioning rules need to see them. */
export interface DeprovisionCandidate {
  id: string;
  role: string;
  isActive: boolean;
  ssoExempt: boolean;
  rosterAbsentSince: Date | null;
  deactivatedBy: string | null;
}

export type SafetyAbort =
  | { reason: 'row_floor'; rowCount: number; minRowCount: number }
  | { reason: 'deactivation_ceiling'; planned: number; covered: number; maxPercent: number };

export function describeSafetyAbort(abort: SafetyAbort): string {
  return abort.reason === 'row_floor'
    ? `row_floor: the file has ${abort.rowCount} data rows, below the floor of ${abort.minRowCount}`
    : `deactivation_ceiling: ${abort.planned} of ${abort.covered} active people would be deactivated, above the ${abort.maxPercent}% ceiling`;
}

/** Valve 1. Null = the file is large enough. */
export function checkRowFloor(rowCount: number, minRowCount: number): SafetyAbort | null {
  const floor = Math.max(0, Math.floor(minRowCount));
  return rowCount < floor ? { reason: 'row_floor', rowCount, minRowCount: floor } : null;
}

/** Whole UTC calendar days from `from` to `to` (never negative). */
export function utcDaysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

export type RefusalReason = 'last_admin' | 'sso_exempt';

export interface DeprovisionPlan {
  /** Absent for the first time: stamp `rosterAbsentSince = now`, nothing else. */
  markAbsent: string[];
  /** Absent, and the grace has run out: deactivate tonight. */
  deactivate: string[];
  /** Absent, already stamped, still inside the grace period. */
  waiting: string[];
  /** Absent and due, but never switched off by a feed. */
  refused: { id: string; reason: RefusalReason }[];
  /** Back in the file after a feed switched them off: reactivate. */
  reactivate: string[];
  /** Back in the file while stamped absent: clear the stamp. */
  clearAbsent: string[];
  /** Set when valve 2 stops the run. Nothing in the lists above may be applied. */
  abort: SafetyAbort | null;
}

export interface PlanDeprovisionInput {
  settings: DeprovisionSettings;
  /** People the feed covers and did NOT mention. */
  absent: DeprovisionCandidate[];
  /** People the feed covers and DID mention. */
  present: DeprovisionCandidate[];
  /** Active people the feed covers — the ceiling's denominator. */
  coveredActiveCount: number;
  /** Active ADMINs of the org — the last-admin guard. */
  activeAdminCount: number;
  now: Date;
  /** An admin approved a run the ceiling stopped (#1967): skip valve 2 only. */
  approved?: boolean;
}

/**
 * Decide what a successful run does to the people it covers.
 *
 * Reappearance is applied whether or not deprovisioning is switched on: a
 * person a feed switched off comes back with the feed, even after a tenant
 * turned the feature off again.
 */
export function planDeprovision(input: PlanDeprovisionInput): DeprovisionPlan {
  const { settings, now } = input;
  const actor = rosterActor(settings.feedId);
  const plan: DeprovisionPlan = {
    markAbsent: [],
    deactivate: [],
    waiting: [],
    refused: [],
    reactivate: [],
    clearAbsent: [],
    abort: null,
  };

  for (const p of input.present) {
    if (!p.isActive && p.deactivatedBy === actor) plan.reactivate.push(p.id);
    if (p.rosterAbsentSince) plan.clearAbsent.push(p.id);
  }

  if (!settings.deprovision) return plan;

  const grace = Math.max(0, Math.floor(settings.deprovisionGraceDays));
  let adminsLeft = input.activeAdminCount;
  // Only people who are still switched on are anyone's business here: an
  // account a human (or an earlier run) already deactivated stays as it is.
  for (const p of input.absent.filter((c) => c.isActive)) {
    if (p.ssoExempt) {
      plan.refused.push({ id: p.id, reason: 'sso_exempt' });
      continue;
    }
    if (p.role === 'ADMIN' && adminsLeft <= 1) {
      plan.refused.push({ id: p.id, reason: 'last_admin' });
      continue;
    }
    if (!p.rosterAbsentSince) {
      plan.markAbsent.push(p.id);
      continue;
    }
    if (utcDaysBetween(p.rosterAbsentSince, now) >= grace && p.rosterAbsentSince < now) {
      plan.deactivate.push(p.id);
      if (p.role === 'ADMIN') adminsLeft -= 1;
    } else {
      plan.waiting.push(p.id);
    }
  }

  // Valve 2, on everyone the feed is on its way to offboarding.
  const planned = plan.markAbsent.length + plan.waiting.length + plan.deactivate.length;
  const maxPercent = Math.max(0, settings.maxDeactivatePercent);
  if (!input.approved && planned > 0 && planned * 100 > input.coveredActiveCount * maxPercent) {
    plan.abort = {
      reason: 'deactivation_ceiling',
      planned,
      covered: input.coveredActiveCount,
      maxPercent,
    };
  }
  return plan;
}

/** Deprovisioning acts only on a run whose every row was read. */
export function canDeprovision(errorRows: number): boolean {
  return errorRows === 0;
}
