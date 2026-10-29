// The re-evaluation that follows a commission-plan change (docs/affiliate-module.md,
// #3170) — the pure half: the state it keeps on AffiliateProgramSettings.planResync
// and how one attempt moves it. Dependency-free, unit-tested in
// scripts/test/affiliate-plan-resync.test.mjs. The I/O half is
// src/lib/affiliatePlanResync.ts.
//
// The state is the admin's progress report AND the job's checkpoint:
//   - `cursor` is the last partner id the first pass has finished (partners are
//     walked in id order); `END` once the pass is through. A rerun of the job —
//     a crash, a timeout, a redeploy — resumes after the cursor instead of
//     starting over.
//   - `retry` holds the partners whose re-evaluation failed (a busy lock), at
//     most RETRY_CAP of them; the job's next attempt runs exactly those. Past the
//     cap only `overflow` is kept, and the next attempt walks every partner again.
//   - `done` counts partners re-evaluated, `failed` those still outstanding,
//     `drift` the frozen commissions the new plan would calculate differently.
//   - `v` is the plan version it is for. Every write of it is guarded on that
//     version, so a newer plan's save makes an older job's writes miss and stop.

export const RESYNC_END = '\u0000END';
export const RETRY_CAP = 500;
export const RESYNC_STATUSES = ['QUEUED', 'RUNNING', 'RETRYING', 'DONE', 'INCOMPLETE'] as const;
export type ResyncStatus = (typeof RESYNC_STATUSES)[number];

export interface PlanResyncState {
  v: number;
  status: ResyncStatus;
  total: number | null;
  done: number;
  failed: number;
  drift: number;
  cursor: string | null;
  retry: string[];
  overflow: boolean;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export function queuedResync(v: number, now: Date): PlanResyncState {
  return { v, status: 'QUEUED', total: null, done: 0, failed: 0, drift: 0, cursor: null, retry: [], overflow: false, queuedAt: now.toISOString(), startedAt: null, finishedAt: null };
}

const nat = (x: unknown) => (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : 0);
const iso = (x: unknown) => (typeof x === 'string' && !Number.isNaN(Date.parse(x)) ? x : null);

/** Reads a stored state defensively; null when there is none or it is not one. */
export function parseResyncState(raw: unknown): PlanResyncState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.v !== 'number' || !Number.isSafeInteger(o.v)) return null;
  if (!(RESYNC_STATUSES as readonly string[]).includes(o.status as string)) return null;
  return {
    v: o.v,
    status: o.status as ResyncStatus,
    total: o.total === null ? null : nat(o.total),
    done: nat(o.done),
    failed: nat(o.failed),
    drift: nat(o.drift),
    cursor: typeof o.cursor === 'string' ? o.cursor : null,
    retry: Array.isArray(o.retry) ? o.retry.filter((x): x is string => typeof x === 'string').slice(0, RETRY_CAP) : [],
    overflow: o.overflow === true,
    queuedAt: iso(o.queuedAt) ?? new Date(0).toISOString(),
    startedAt: iso(o.startedAt),
    finishedAt: iso(o.finishedAt),
  };
}

/** True while a job is still expected to move the state. */
export function resyncInFlight(s: PlanResyncState | null): boolean {
  return s !== null && (s.status === 'QUEUED' || s.status === 'RUNNING' || s.status === 'RETRYING');
}

/**
 * What an attempt does first. A state past its first pass with partners to retry
 * runs those only; one that overflowed the retry list walks every partner again
 * (and counts afresh, since every partner is judged again).
 */
export function beginAttempt(s: PlanResyncState, now: Date): { state: PlanResyncState; mode: 'pass' | 'retry' } {
  const base: PlanResyncState = { ...s, status: 'RUNNING', startedAt: s.startedAt ?? now.toISOString(), finishedAt: null };
  if (s.cursor !== RESYNC_END) return { state: base, mode: 'pass' };
  if (s.overflow) return { state: { ...base, cursor: null, done: 0, drift: 0, failed: 0, retry: [], overflow: false }, mode: 'pass' };
  return { state: base, mode: 'retry' };
}

export interface PartnerOutcome {
  id: string;
  ok: boolean;
  drift: number;
}

/** One batch of the first pass: counts it and moves the cursor past it. */
export function recordPassBatch(s: PlanResyncState, outcomes: PartnerOutcome[]): PlanResyncState {
  let { done, drift, failed, overflow } = s;
  const retry = [...s.retry];
  for (const o of outcomes) {
    if (o.ok) {
      done += 1;
      drift += o.drift;
      continue;
    }
    failed += 1;
    if (retry.length < RETRY_CAP) retry.push(o.id);
    else overflow = true;
  }
  const cursor = outcomes.length > 0 ? outcomes[outcomes.length - 1].id : s.cursor;
  return { ...s, done, drift, failed, retry, overflow, cursor };
}

/** The retry list run again: what failed stays for the next attempt. */
export function recordRetry(s: PlanResyncState, outcomes: PartnerOutcome[]): PlanResyncState {
  let { done, drift } = s;
  const retry: string[] = [];
  for (const o of outcomes) {
    if (o.ok) {
      done += 1;
      drift += o.drift;
    } else retry.push(o.id);
  }
  return { ...s, done, drift, retry, failed: retry.length };
}

/**
 * The end of an attempt. Nothing outstanding: DONE. Partners outstanding and
 * attempts left: RETRYING (the caller throws, so the worker backs off and runs
 * the next attempt). On the last attempt: INCOMPLETE — those partners are
 * re-evaluated by their next payment write, as before the queue existed.
 */
export function finishAttempt(s: PlanResyncState, attempt: number, maxAttempts: number, now: Date): PlanResyncState {
  const outstanding = s.retry.length > 0 || s.overflow;
  const closed = { ...s, cursor: RESYNC_END };
  if (!outstanding) return { ...closed, status: 'DONE', failed: 0, finishedAt: now.toISOString() };
  if (attempt < maxAttempts) return { ...closed, status: 'RETRYING' };
  return { ...closed, status: 'INCOMPLETE', finishedAt: now.toISOString() };
}
