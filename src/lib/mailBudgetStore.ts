import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { budgetNameFor, laneToleranceMs, type BudgetConfig, type MailLane } from '@/lib/mailDeliveryRule';

// The `MailBudget` half of the shared send budget (#2941): the row operations
// and nothing else. The arithmetic — lanes, tolerance, the critical reserve,
// the throttle ladder — is pure in `mailDeliveryRule.ts` (`gcraSpend`,
// `applyThrottle`, `decayPauseLevel` are the in-memory twins of the SQL below,
// and the unit test pins them).
//
// THREE RULES, the same ones `jobs/leaseStore.ts` lives by:
//   • Every transition is ONE statement. A token is spent by a conditional
//     `UPDATE … WHERE name = ? AND tat <= UTC_TIMESTAMP(3) + τ` whose affected-row count
//     is the decision, so two replicas can never both spend the last token — a
//     read-then-write could.
//   • The clock is the DATABASE's (`UTC_TIMESTAMP(3)`), never a replica's: two app
//     containers with drifting clocks would otherwise each think the budget had
//     refilled. UTC, not `NOW(3)`: `tat` is a DATETIME that Prisma reads back as
//     UTC, and `NOW()` follows the session time zone — off by the offset on a
//     non-UTC server, and an hour ahead of itself at every DST fall-back.
//   • A database error is not a decision. `spendToken` reports it, and the
//     CALLER's lane decides: CRITICAL fails open (a password reset is never
//     held back because the meter is unreachable), every other lane is refused.
//
// This is a meter, not a lease: nobody holds the row and nobody is elected, so
// it is not a second election mechanism (CLAUDE.md § single-owner work).
//
// Raw SQL rather than `updateMany` because Prisma has no way to say "tat =
// GREATEST(tat, UTC_TIMESTAMP(3)) + interval" in one statement. The table is literally
// `MailBudget` (no `@@map`), backticked because raw SQL is not quoted for us.
// Interval lengths are interpolated with `Prisma.raw`: they are integers this
// module computed from a clamped config (`budgetConfig`), never user input — the
// same argument `queueStore.ts` makes for its LIMIT. The name is bound.

/** The primary channel's row; the bulk channel's is `budgetNameFor('bulk')`. */
export const SMTP_BUDGET = budgetNameFor('primary');

export type SpendReason = 'spent' | 'refused' | 'db_error';

export interface SpendOutcome {
  /** May this mail go now? On a database error: CRITICAL true, others false. */
  allowed: boolean;
  reason: SpendReason;
  /** Refused only: how long until this lane would be allowed. */
  waitMs: number;
  /** Refused only: the throttle ladder's current rung (0 = not paused). */
  pauseLevel?: number;
}

function micros(ms: number): Prisma.Sql {
  return Prisma.raw(String(Math.trunc(ms) * 1000));
}

/** Creates the row the first time a budget is touched. INSERT IGNORE: a second
 *  replica racing to create it is the mechanism working, not an error. */
async function ensureRow(name: string): Promise<boolean> {
  const inserted = await prisma.$executeRaw(Prisma.sql`
    INSERT IGNORE INTO \`MailBudget\` (name, tat, pauseLevel, dayCount, updatedAt)
    VALUES (${name}, UTC_TIMESTAMP(3), 0, 0, UTC_TIMESTAMP(3))
  `);
  return inserted === 1;
}

async function conditionalSpend(name: string, lane: MailLane, cfg: BudgetConfig): Promise<boolean> {
  const changed = await prisma.$executeRaw(Prisma.sql`
    UPDATE \`MailBudget\`
       SET tat = GREATEST(tat, UTC_TIMESTAMP(3)) + INTERVAL ${micros(cfg.intervalMs)} MICROSECOND,
           updatedAt = UTC_TIMESTAMP(3)
     WHERE name = ${name}
       AND tat <= UTC_TIMESTAMP(3) + INTERVAL ${micros(laneToleranceMs(lane, cfg))} MICROSECOND
  `);
  return changed === 1;
}

type AheadRow = { ahead: bigint | number | null; paused: bigint | number | null; pauseLevel: number };

async function readAhead(name: string): Promise<AheadRow | null> {
  const rows = await prisma.$queryRaw<AheadRow[]>(Prisma.sql`
    SELECT TIMESTAMPDIFF(MICROSECOND, UTC_TIMESTAMP(3), tat) AS ahead,
           TIMESTAMPDIFF(MICROSECOND, UTC_TIMESTAMP(3), pausedUntil) AS paused,
           pauseLevel
      FROM \`MailBudget\` WHERE name = ${name}
  `);
  return rows[0] ?? null;
}

/**
 * Spend one token for a mail of this lane — or report that the lane would have
 * to wait. One conditional UPDATE when granted; a refusal adds one SELECT
 * (the wait to report). The row is created only when that SELECT finds none —
 * once per budget, never on every refusal.
 */
export async function spendToken(lane: MailLane, cfg: BudgetConfig, name: string = SMTP_BUDGET): Promise<SpendOutcome> {
  try {
    if (await conditionalSpend(name, lane, cfg)) return { allowed: true, reason: 'spent', waitMs: 0 };
    // Zero rows: either refused, or the row does not exist yet.
    let row = await readAhead(name);
    if (!row) {
      await ensureRow(name);
      if (await conditionalSpend(name, lane, cfg)) return { allowed: true, reason: 'spent', waitMs: 0 };
      row = await readAhead(name);
    }
    const aheadMs = Number(row?.ahead ?? 0) / 1000;
    return {
      allowed: false,
      reason: 'refused',
      waitMs: Math.max(0, Math.round(aheadMs - laneToleranceMs(lane, cfg))),
      pauseLevel: Number(row?.pauseLevel ?? 0),
    };
  } catch {
    return { allowed: lane === 'CRITICAL', reason: 'db_error', waitMs: 0 };
  }
}

/**
 * Record a send the meter did not grant (observe mode: the mail went anyway).
 * Unconditional, so the meter keeps describing what the relay actually saw and
 * the next `would_refuse` line tells the truth about the wait.
 */
export async function chargeToken(cfg: BudgetConfig, name: string = SMTP_BUDGET): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    UPDATE \`MailBudget\`
       SET tat = GREATEST(tat, UTC_TIMESTAMP(3)) + INTERVAL ${micros(cfg.intervalMs)} MICROSECOND,
           updatedAt = UTC_TIMESTAMP(3)
     WHERE name = ${name}
  `);
}

/**
 * A relay throttle: push `tat` out by the current rung of the ladder, mark the
 * pause's end in `pausedUntil`, and climb one rung, in one statement. MySQL
 * evaluates single-table SET assignments left to right, so `tat` and
 * `pausedUntil` read the OLD `pauseLevel` — the same order `applyThrottle()`
 * uses. `pausedUntil` is what the breaker reads (#2944): unlike `tat` it says
 * how long the RELAY is paused, never how much mail was metered.
 */
export async function pauseBudget(cfg: BudgetConfig, name: string = SMTP_BUDGET): Promise<void> {
  const ladder = cfg.ladderSec.map((s) => Math.trunc(s));
  const top = ladder.length - 1;
  await ensureRow(name);
  await prisma.$executeRaw(Prisma.sql`
    UPDATE \`MailBudget\`
       SET tat = GREATEST(tat, UTC_TIMESTAMP(3) + INTERVAL CAST(ELT(LEAST(pauseLevel, ${Prisma.raw(String(top))}) + 1, ${Prisma.raw(ladder.join(', '))}) AS UNSIGNED) SECOND),
           pausedUntil = GREATEST(COALESCE(pausedUntil, UTC_TIMESTAMP(3)), UTC_TIMESTAMP(3) + INTERVAL CAST(ELT(LEAST(pauseLevel, ${Prisma.raw(String(top))}) + 1, ${Prisma.raw(ladder.join(', '))}) AS UNSIGNED) SECOND),
           pauseLevel = LEAST(pauseLevel + 1, ${Prisma.raw(String(top))}),
           updatedAt = UTC_TIMESTAMP(3)
     WHERE name = ${name}
  `);
}

/** A delivered mail walks the ladder one rung back down. A no-op write when
 *  the budget is not paused (the WHERE matches nothing). True when a rung was
 *  removed, so a caller can stop decaying once the ladder is back at 0. */
export async function decayPause(name: string = SMTP_BUDGET): Promise<boolean> {
  const changed = await prisma.$executeRaw(Prisma.sql`
    UPDATE \`MailBudget\` SET pauseLevel = pauseLevel - 1, updatedAt = UTC_TIMESTAMP(3)
     WHERE name = ${name} AND pauseLevel > 0
  `);
  return changed === 1;
}

/**
 * The budget against the DATABASE clock: how far `tat` is ahead (the meter),
 * how long the relay pause still runs (`pausedMs`, ≤ 0 when it is over or there
 * never was one — what the breaker, `breakerOpen()` in mailWorkerRule.ts,
 * decides on) and the throttle rung. One SELECT; null when the row does not
 * exist yet. Throws on a database error: the caller decides what an unreadable
 * budget means for its lane.
 */
export async function readBudgetState(
  name: string = SMTP_BUDGET,
): Promise<{ aheadMs: number; pausedMs: number; pauseLevel: number } | null> {
  const row = await readAhead(name);
  if (!row) return null;
  return {
    aheadMs: Number(row.ahead ?? 0) / 1000,
    pausedMs: row.paused === null || row.paused === undefined ? 0 : Number(row.paused) / 1000,
    pauseLevel: Number(row.pauseLevel ?? 0),
  };
}

/** The meter's state, for health views and tests. Null when never touched. */
export async function readBudget(
  name: string = SMTP_BUDGET,
): Promise<{ tat: Date; pauseLevel: number; dayKey: string | null; dayCount: number } | null> {
  return prisma.mailBudget.findUnique({
    where: { name },
    select: { tat: true, pauseLevel: true, dayKey: true, dayCount: true },
  });
}
