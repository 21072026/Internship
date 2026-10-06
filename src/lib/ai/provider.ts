// Provider resilience for every AI call (#2024) — server-only.
//
// runAiGated (src/lib/aiGate.ts) runs each logical AI task through
// `callProvider`, so ONE task is ONE metered call however many attempts it
// took, and a failure never consumes quota:
//   • RETRIES: at most MAX_RETRIES, only on 429 / 5xx / timeout / connection
//     loss, with exponential backoff and jitter, and never starting an attempt
//     that could not finish inside the request budget. A 4xx other than 429 is
//     the request's fault and is not retried. The SDK's own retries are off in
//     every client (`maxRetries: 0`) so the two cannot multiply.
//   • A CIRCUIT BREAKER, per process: BREAKER_THRESHOLD failures inside the
//     window open it for a cool-down, during which calls fail fast with no
//     network call; the first call after the cool-down is the probe. It is
//     per-container and therefore best-effort — a cost guard, not a
//     distributed breaker.
//   • SAFE PARSING: `safeParseModelJson` strips a code fence, parses and
//     validates against the task's schema, and returns the task's fallback —
//     marking the call `parse_error` — instead of throwing on a reply that is
//     not the JSON asked for.
//
// #2022 adds `callModel()` (the registry and per-task routing) to this module;
// these pieces are what it will call through.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { z } from 'zod';

export const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 500;
/** No attempt starts after this much of the request has gone (the handler budget is 60s). */
export const ATTEMPT_DEADLINE_MS = 45_000;
export const BREAKER_THRESHOLD = 5;
export const BREAKER_WINDOW_MS = 60_000;
export const BREAKER_COOLDOWN_MS = 60_000;

/** Thrown when the breaker is open — no request was made. */
export class ProviderUnavailable extends Error {
  constructor() {
    super('AI provider temporarily unavailable (circuit open)');
    this.name = 'ProviderUnavailable';
  }
}

/** Whether a failure is worth another attempt: rate limited, the provider's fault, or the network's. */
export function isRetryableProviderError(error: unknown): boolean {
  const e = error as { status?: unknown; name?: unknown; code?: unknown; message?: unknown } | null;
  if (!e || typeof e !== 'object') return false;
  if (typeof e.status === 'number') return e.status === 429 || e.status >= 500;
  const name = String(e.name ?? '');
  if (/APIConnection(Timeout)?Error|TimeoutError|AbortError/.test(name)) return true;
  const code = String(e.code ?? '');
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_SOCKET'].includes(code)) return true;
  return /timed? ?out|socket hang up|network/i.test(String(e.message ?? ''));
}

export interface RetryOptions {
  maxRetries?: number;
  deadlineMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

/** Run `fn`, retrying a retryable failure with jittered exponential backoff inside the deadline. */
export async function withRetries<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  const deadline = opts.deadlineMs ?? ATTEMPT_DEADLINE_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const started = now();
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxRetries || !isRetryableProviderError(error)) throw error;
      // Full jitter: anywhere up to the exponential step, so a burst of
      // callers does not retry in lockstep.
      const backoff = Math.round(random() * BASE_BACKOFF_MS * 2 ** attempt);
      if (now() - started + backoff >= deadline) throw error;
      await sleep(backoff);
    }
  }
}

/** A process-local circuit breaker (see the header). */
export class CircuitBreaker {
  private failures: number[] = [];
  private openedAt: number | null = null;

  private readonly opts: { threshold?: number; windowMs?: number; coolDownMs?: number; now?: () => number };

  // A plain field, not a parameter property: the unit tests load this file
  // through Node's type stripping, which has no parameter properties.
  constructor(opts: { threshold?: number; windowMs?: number; coolDownMs?: number; now?: () => number } = {}) {
    this.opts = opts;
  }

  private get now() {
    return this.opts.now ?? Date.now;
  }

  /** 'closed' (calls go through), 'open' (fail fast) or 'half-open' (the next call is the probe). */
  state(): 'closed' | 'open' | 'half-open' {
    if (this.openedAt === null) return 'closed';
    return this.now() - this.openedAt >= (this.opts.coolDownMs ?? BREAKER_COOLDOWN_MS) ? 'half-open' : 'open';
  }

  canCall(): boolean {
    return this.state() !== 'open';
  }

  success(): void {
    this.failures = [];
    this.openedAt = null;
  }

  failure(): void {
    const t = this.now();
    // A failed probe re-opens at once.
    if (this.state() === 'half-open') {
      this.openedAt = t;
      return;
    }
    const windowMs = this.opts.windowMs ?? BREAKER_WINDOW_MS;
    this.failures = [...this.failures.filter((f) => t - f < windowMs), t];
    if (this.failures.length >= (this.opts.threshold ?? BREAKER_THRESHOLD)) this.openedAt = t;
  }
}

const providerBreaker = new CircuitBreaker();

/** One logical provider call: breaker first, then the retries. Throws when it finally fails. */
export async function callProvider<T>(fn: () => Promise<T>, breaker: CircuitBreaker = providerBreaker): Promise<T> {
  if (!breaker.canCall()) throw new ProviderUnavailable();
  try {
    const result = await withRetries(fn);
    breaker.success();
    return result;
  } catch (error) {
    breaker.failure();
    throw error;
  }
}

// ── Parsing ──────────────────────────────────────────────────────────────────

const parseTracking = new AsyncLocalStorage<{ parseError: boolean }>();

/** Run `fn`, reporting whether any safeParseModelJson inside it fell back. */
export async function trackParseErrors<T>(fn: () => Promise<T>): Promise<{ result: T; parseError: boolean }> {
  const store = { parseError: false };
  const result = await parseTracking.run(store, fn);
  return { result, parseError: store.parseError };
}

/**
 * Mark the running call parse_error from a parser that is not
 * safeParseModelJson (e.g. one that also verifies the reply against its
 * input). runAiGated then meters it as parse_error and keeps no artefact.
 */
export function noteParseError(): void {
  const store = parseTracking.getStore();
  if (store) store.parseError = true;
}

/** Strip one surrounding ``` fence (with or without a language tag). */
export function stripCodeFence(raw: string): string {
  const m = raw.trim().match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/);
  return m ? m[1] : raw.trim();
}

/**
 * Parse a model reply as JSON and validate it. On anything else — no text,
 * not JSON, the wrong shape — return `fallback` and mark the call parse_error.
 */
export function safeParseModelJson<T>(raw: string | null | undefined, schema: z.ZodType<T>, fallback: T): T {
  const fail = () => {
    const store = parseTracking.getStore();
    if (store) store.parseError = true;
    return fallback;
  };
  if (!raw || !raw.trim()) return fail();
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(raw));
  } catch {
    return fail();
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : fail();
}
