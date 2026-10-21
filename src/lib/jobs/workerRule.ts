// The job worker's rules (#1673) — pure, dependency-free, unit-tested in
// `e2e/job-worker.unit.spec.ts`. The loop that applies them is `./worker`.
//
// Two decisions live here and nowhere else:
//
//   1. WHEN A FAILED ATTEMPT RUNS AGAIN. Exponential backoff with jitter:
//        delay = min(baseMs · 2^(attempt−1), capMs) · jitter,  jitter ∈ [0.75, 1.25)
//      The jitter is not decoration. A dozen jobs that failed on the same SMTP
//      outage would otherwise retry in lockstep, on the same second, against one
//      MySQL box and one relay — a thundering herd that turns a recovered outage
//      into a second one. The cap is applied BEFORE the jitter so capped retries
//      still spread out instead of all landing on exactly `capMs`.
//
//   2. WHAT A FAILED ATTEMPT BECOMES. `attempt` counts the attempt that just
//      failed (1-based). Below `maxAttempts` the job goes back to PENDING with a
//      future `runAt`; at or above it the job is DEAD_LETTER and nothing claims
//      it again — the daily dead-letter alert (`./dlqAlert`) makes it visible.

export interface BackoffPolicy {
  /** Delay before the second attempt, before jitter. */
  baseMs: number;
  /** Ceiling on any single delay, before jitter. */
  capMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 30_000, capMs: 60 * 60_000 };

/** Per-attempt timeout when a handler names none. */
export const DEFAULT_JOB_TIMEOUT_MS = 5 * 60_000;

const JITTER_MIN = 0.75;
const JITTER_SPAN = 0.5;

/**
 * Delay before the next attempt, given the attempt that just failed (1-based).
 * `random` is injectable so a test can pin the jitter; it must return [0, 1).
 */
export function backoffDelayMs(attempt: number, policy: BackoffPolicy = DEFAULT_BACKOFF, random: () => number = Math.random): number {
  const n = Math.max(1, Math.trunc(attempt));
  const base = Math.max(1, policy.baseMs);
  const cap = Math.max(base, policy.capMs);
  // 2^(n−1) overflows to Infinity long before it matters; min() absorbs it.
  const raw = Math.min(base * 2 ** (n - 1), cap);
  const r = Math.min(Math.max(random(), 0), 0.999_999);
  return Math.round(raw * (JITTER_MIN + r * JITTER_SPAN));
}

export type FailureOutcome =
  | { status: 'PENDING'; attempts: number; runAt: Date }
  | { status: 'DEAD_LETTER'; attempts: number };

/** What a failed attempt turns the job into. */
export function failureOutcome(
  attempt: number,
  maxAttempts: number,
  now: Date,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  random: () => number = Math.random
): FailureOutcome {
  if (attempt >= Math.max(1, maxAttempts)) return { status: 'DEAD_LETTER', attempts: attempt };
  return { status: 'PENDING', attempts: attempt, runAt: new Date(now.getTime() + backoffDelayMs(attempt, policy, random)) };
}

/** `lastError` is TEXT, but nobody reads past the first lines of a stack. */
export const LAST_ERROR_MAX = 2_000;

export function errorText(error: unknown): string {
  let text: string;
  if (error instanceof Error) text = error.message || error.name;
  else if (typeof error === 'string') text = error;
  else {
    try {
      text = JSON.stringify(error) ?? String(error);
    } catch {
      text = String(error);
    }
  }
  return text.length > LAST_ERROR_MAX ? `${text.slice(0, LAST_ERROR_MAX - 1)}…` : text;
}

/** The thrown value of an attempt that ran past its timeout. */
export class JobTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`job timed out after ${timeoutMs} ms`);
    this.name = 'JobTimeoutError';
  }
}
