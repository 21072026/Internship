// Monthly won-deal target and team leaderboard for sales reps — the rule.
//
// Pure and dependency-free (type imports only), so the unit runner loads it
// under node's strip-only type stripping (scripts/test/sales-target.test.mjs).
// The queries live in src/lib/salesTarget.ts; the month arithmetic is
// src/lib/meteringRules.ts's (`currentPeriod()`/`periodRange()`), never here.
//
// WHERE IT APPLIES. The MARKETING sales surface only (`/sales`, #2580): a
// vertical with a pipeline and WITHOUT the `mentorship` module. The internship
// product made points, badges and leaderboards a non-goal (roadmap 2026-08,
// competitive analysis §4.5) — comparing candidates with each other is exactly
// what it must not do — so this rule refuses every vertical that carries
// `mentorship`, and the page, the settings form and the settings API all ask it.
//
// WHAT COUNTS AS "WON THIS MONTH". A deal whose FIRST move into one of the
// tenant's won stages (`outcomeStageKeysFrom().finished`) was recorded in the
// month. "First" for the same reason the deal-value card uses it
// (src/lib/dealValue.ts, rule 3): a deal won in March, lost and re-won in April
// is one win, in March.
//
// TRANSFER CHAINS ARE ONE DEAL. A handover (#2289) closes the relation and
// opens a successor on the SAME stage, linked by `previousRelationId`. As
// dealValue.ts does, the chain is folded into one journey (every link's moves,
// root first) before "first win" is read. So a deal won by rep A in March,
// lost, handed to rep B and re-won by B in April is still one win, in March,
// for A; and a successor that inherits a won stage is never a second win.
// The win is credited to the owner (`mentorId`) of the LINK in which the first
// win was recorded: a handover keeps the closed relation on the old owner, so
// the win stays where it was made; only an in-place correction (a
// mis-assignment with no history, so no stage move) changes the owner.
//
// ONE DELIBERATE DIFFERENCE FROM THE DEAL-VALUE CARD. dealValue counts a
// journey that STARTED in a won stage as won at its start; this rule does not
// count it at all. A deal created or imported straight into a won stage was
// not won by a recorded move, and a target is about wins a rep made — so the
// two cards can differ for exactly those deals, and only for them.
//
// WHAT IS DELIBERATELY NOT HERE. No points, no streaks, no deal values on the
// leaderboard (names and counts only), and nothing that rewards logging
// activity — the billing meter counts relations with logged activity
// (docs/metering.md), so a game built on activity would inflate the customer's
// bill. The leaderboard is opt-in for reps (`salesLeaderboardForReps`, default
// off) and always visible to the org's admins.

import type { VerticalCapability } from './verticals';

/** Does the sales target / leaderboard exist in a vertical carrying `caps`? */
export function salesTargetApplies(caps: readonly VerticalCapability[]): boolean {
  return caps.includes('pipeline') && !caps.includes('mentorship');
}

/** Largest target the settings API accepts (the `\d{1,4}` regex). */
export const SALES_TARGET_MAX = 9999;

/**
 * The stored target, read: a positive whole number, or null for "no target".
 * Empty, `0`, negative, fractional or unparseable all mean "no target" — a
 * corrupted row must never show a rep a target nobody set.
 */
export function parseWonTarget(raw: string | null | undefined): number | null {
  const s = (raw ?? '').trim();
  if (!/^\d{1,4}$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

/** Is a value the settings API may store as the target? (`''` clears it.) */
export function isValidWonTargetInput(raw: string): boolean {
  return raw === '' || /^\d{1,4}$/.test(raw);
}

/** The stored leaderboard flag, read. Only the literal `'true'` switches it on. */
export function parseLeaderboardForReps(raw: string | null | undefined): boolean {
  return raw === 'true';
}

/** Who sees the team leaderboard: the org's admins always, a rep only when switched on. */
export function canSeeLeaderboard(role: string | null | undefined, forReps: boolean): boolean {
  if (role === 'ADMIN') return true;
  return role === 'MENTOR' && forReps;
}

/** One recorded stage move of a deal, oldest first. */
export interface StageMove {
  fromStatus: string;
  toStatus: string;
  /** ms since epoch */
  at: number;
}

/**
 * When the deal was won by a move (ms), or null: the first move into a won
 * stage, unless the deal's history starts in a won stage (see the header).
 * `moves` must be in recorded order and, for a transfer chain, already folded
 * root first (`wonCountsByOwner` does that).
 */
export function wonByMoveAt(moves: readonly StageMove[], wonKeys: readonly string[]): number | null {
  const i = firstWinIndex(moves, wonKeys);
  return i === -1 ? null : moves[i].at;
}

/** Index of the move that won the deal, or -1 (same rule as `wonByMoveAt`). */
function firstWinIndex(moves: readonly StageMove[], wonKeys: readonly string[]): number {
  if (moves.length === 0 || wonKeys.length === 0) return -1;
  const won = new Set(wonKeys);
  if (won.has(moves[0].fromStatus)) return -1;
  return moves.findIndex((m) => won.has(m.toStatus));
}

/** A deal (one relation) as the counter needs it. */
export interface DealHistory {
  /** The relation's id — needed only to fold transfer chains. */
  id?: string;
  /** `previousRelationId`: the relation this one was handed over from. */
  previousId?: string | null;
  ownerId: string;
  moves: readonly StageMove[];
}

/**
 * Wins per owner in the half-open window `[gte, lt)` — exactly the shape
 * `periodRange()` returns. Owners without a win are absent from the map.
 *
 * Transfer chains are folded first (see the header): each relation is read as
 * the tail of its chain, root first, and is credited only when the chain's
 * first win was recorded in THAT relation — so a chain yields at most one win,
 * however many of its links are passed in. A predecessor missing from `deals`
 * ends the chain there, so the caller loads every link. A cycle, which no
 * write path produces, cannot loop.
 */
export function wonCountsByOwner(
  deals: readonly DealHistory[],
  wonKeys: readonly string[],
  range: { gte: Date; lt: Date },
): Map<string, number> {
  const from = range.gte.getTime();
  const to = range.lt.getTime();
  const byId = new Map<string, DealHistory>();
  for (const d of deals) if (d.id) byId.set(d.id, d);
  const out = new Map<string, number>();
  for (const deal of deals) {
    const chain: DealHistory[] = [deal];
    const seen = new Set<string>(deal.id ? [deal.id] : []);
    let prevId = deal.previousId ?? null;
    while (prevId && !seen.has(prevId)) {
      const prev = byId.get(prevId);
      if (!prev) break;
      seen.add(prevId);
      chain.unshift(prev);
      prevId = prev.previousId ?? null;
    }
    const moves: StageMove[] = [];
    let ownStart = 0;
    for (const link of chain) {
      if (link === deal) ownStart = moves.length;
      moves.push(...link.moves);
    }
    const i = firstWinIndex(moves, wonKeys);
    if (i < ownStart) continue; // no win, or the chain was won in an earlier link
    const at = moves[i].at;
    if (at < from || at >= to) continue;
    out.set(deal.ownerId, (out.get(deal.ownerId) ?? 0) + 1);
  }
  return out;
}

export interface TargetProgress {
  won: number;
  /** null = no target set */
  target: number | null;
  /** 0..100, whole number, capped at 100; null without a target */
  percent: number | null;
  reached: boolean;
}

/** Progress against the target. Over-achieving caps the bar, never the count. */
export function targetProgress(won: number, target: number | null): TargetProgress {
  const w = Math.max(0, Math.floor(won));
  if (target === null || target <= 0) return { won: w, target: null, percent: null, reached: false };
  return { won: w, target, percent: Math.min(100, Math.floor((w / target) * 100)), reached: w >= target };
}

export interface LeaderboardEntry {
  userId: string;
  name: string;
  won: number;
}

export interface RankedEntry extends LeaderboardEntry {
  /** Competition rank: equal counts share a rank (1, 1, 3). */
  rank: number;
}

/**
 * Rank reps by wins this month, most first; equal counts are ordered by name
 * (locale-aware, then id so the order is total) and SHARE a rank — ordering a
 * tie by name is a display order, not a verdict that one of them did better.
 */
export function rankLeaderboard(entries: readonly LeaderboardEntry[], locale = 'en'): RankedEntry[] {
  const sorted = [...entries].sort(
    (a, b) =>
      b.won - a.won ||
      a.name.localeCompare(b.name, locale, { sensitivity: 'base' }) ||
      (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
  );
  const out: RankedEntry[] = [];
  sorted.forEach((e, i) => {
    const rank = i > 0 && sorted[i - 1].won === e.won ? out[i - 1].rank : i + 1;
    out.push({ ...e, rank });
  });
  return out;
}
