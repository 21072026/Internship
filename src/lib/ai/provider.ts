// The one provider module (#2022, #2024) — server-only, and the ONLY file in
// the repo that imports `@anthropic-ai/sdk`. A feature module (src/lib/ai*.ts)
// holds a prompt and a parser and calls `callModel()`; it never constructs a
// client, picks a model or sets a timeout. `scripts/test/ai-tasks.test.mjs`
// pins the single-importer rule.
//
//   • `callModel({ task, system, input, jsonSchema? })` sends ONE user message
//     under the task's registry entry (src/lib/ai/tasks.ts): the model from
//     `resolveModel()`, the task's input cap applied here, the task's output
//     cap as `max_tokens`, the central AI_TIMEOUT_MS. It records what the
//     provider answered with — model, token counts, latency — into the call
//     tracking store, which `runAiGated` reads to write the `AiUsage` row.
//   • `resolveModel(task)`: `AI_MODEL_<TASK_ID>` → `AI_MODEL_TIER_<TIER>` → the
//     task's legacy env var (`ANTHROPIC_SUMMARY_MODEL`) → `ANTHROPIC_CV_MODEL`
//     → DEFAULT_MODEL. Changing a model is an env change, never a deploy.
//   • `isAiConfigured()` lives here because the credential is a provider
//     concern; `src/lib/cvExtractAi.ts` re-exports it for one release.
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

import { AsyncLocalStorage } from 'node:async_hooks';
import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { AI_TASKS, type AiModelTier, type AiTaskId, type AiTaskSpec } from '@/lib/ai/tasks';
import { UNTRUSTED_DATA_RULE, mapUntrustedBlocks, untrustedBlocks } from '@/lib/ai/untrusted';
import { redactForPrompt } from '@/lib/ai/redact';
import { injectionSignals } from '@/lib/ai/injection';

export const AI_PROVIDER = 'anthropic';
/** The model every tier resolves to unless an env var says otherwise (the pre-#2022 default). */
export const DEFAULT_MODEL = 'claude-opus-4-8';
/**
 * A generation that has not answered in a minute is not going to. The SDK's
 * own default timeout is 10 minutes, long enough to hold a request handler
 * open until the user gives up (#895); generation genuinely takes tens of
 * seconds, so 60s — not the 5s webhooks get.
 */
export const AI_TIMEOUT_MS = 60_000;

export function isAiConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/** `AI_MODEL_CV_EXTRACT`, `AI_MODEL_TIER_FAST`, … — the env var names, derived so docs and code cannot drift. */
export function modelEnvVar(task: AiTaskId): string {
  return `AI_MODEL_${task.toUpperCase()}`;
}
export function tierEnvVar(tier: AiModelTier): string {
  return `AI_MODEL_TIER_${tier.toUpperCase()}`;
}

/** The model a task runs on (see the header for the order). An empty variable is unset. */
export function resolveModel(task: AiTaskId, env: Record<string, string | undefined> = process.env): string {
  const spec: AiTaskSpec = AI_TASKS[task];
  return (
    env[modelEnvVar(task)] ||
    env[tierEnvVar(spec.tier)] ||
    (spec.legacyModelEnv ? env[spec.legacyModelEnv] : undefined) ||
    env.ANTHROPIC_CV_MODEL ||
    DEFAULT_MODEL
  );
}

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

/** This container's breaker, for the operator console (#2030): per process, so it describes the replica that answered. */
export function providerBreakerState(): 'closed' | 'open' | 'half-open' {
  return providerBreaker.state();
}

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

// ── The model call ───────────────────────────────────────────────────────────

/** What one logical call spent, summed over its attempts (#2022). */
export interface AiCallUsage {
  provider: string;
  /** The model the provider answered with; the resolved one until it answers. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Time waiting on the provider, every attempt included. */
  latencyMs: number;
  /** How many provider requests completed. 0 means the usage is a resolved model and nothing else. */
  completed: number;
  /** Injection tripwire hits over the untrusted blocks (#2026) — flagged, never blocking. */
  flags: string[];
}

interface CallTracking {
  parseError: boolean;
  usage: AiCallUsage | null;
}

const callTracking = new AsyncLocalStorage<CallTracking>();

/**
 * Run one logical AI call, collecting what its `callModel`s spent and whether
 * any parser inside it fell back. runAiGated wraps every task in this.
 */
export async function trackAiCall<T>(fn: () => Promise<T>): Promise<{ result: T; parseError: boolean; usage: AiCallUsage | null }> {
  const store: CallTracking = { parseError: false, usage: null };
  try {
    const result = await callTracking.run(store, fn);
    return { result, parseError: store.parseError, usage: store.usage };
  } catch (error) {
    // The usage so far rides on the error, so a provider_error row can still
    // say which model was asked (`usageOfFailure`).
    (error as { aiUsage?: AiCallUsage | null }).aiUsage = store.usage;
    throw error;
  }
}

/** The usage a failed `trackAiCall` attached to its error, if any. */
export function usageOfFailure(error: unknown): AiCallUsage | null {
  const e = error as { aiUsage?: AiCallUsage | null } | null;
  return e && typeof e === 'object' && e.aiUsage ? e.aiUsage : null;
}

/** @deprecated since #2022 — `trackAiCall` is the same call with the usage too. Kept for one release. */
export async function trackParseErrors<T>(fn: () => Promise<T>): Promise<{ result: T; parseError: boolean }> {
  const { result, parseError } = await trackAiCall(fn);
  return { result, parseError };
}

export interface ModelCall {
  task: AiTaskId;
  system: string;
  /**
   * The one user message. Cut to the task's `maxInputChars` here. Everything a
   * person wrote must sit inside a `wrapUntrusted()` block — an input without
   * one is refused (#2026).
   */
  input: string;
  /** A JSON schema pinned on the reply (structured tasks). */
  jsonSchema?: Record<string, unknown>;
  /** Lower than the task's `maxOutputTokens`; never higher. */
  maxTokens?: number;
}

/** The provider request, injectable so a unit test can answer without a network. */
export type ModelCreate = (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;

const defaultCreate: ModelCreate = (params) =>
  // Constructed per call so the key is read when the call is made (an e2e
  // spec sets it at runtime); retries are callProvider's, so the SDK's are off.
  new Anthropic({ timeout: AI_TIMEOUT_MS, maxRetries: 0 }).messages.create(params);

/** Thrown when a feature module sends user text without fencing it — a programmer error, caught by the tests. */
export class UnfencedInputError extends Error {
  constructor(task: string) {
    super(`callModel(${task}): the input carries no wrapUntrusted() block`);
    this.name = 'UnfencedInputError';
  }
}

/**
 * Shorten the largest untrusted block until the input fits the task's cap, so
 * the cut lands inside the data and never through a closing fence (a plain
 * slice would leave the block open). The slice in callModel stays as the
 * backstop.
 */
export function fitToBudget(input: string, max: number): string {
  let out = input;
  for (let i = 0; i < 4 && out.length > max; i++) {
    const blocks = untrustedBlocks(out);
    if (!blocks.length) break;
    const largest = blocks.reduce((a, b) => (b.content.length > a.content.length ? b : a));
    const keep = Math.max(0, largest.content.length - (out.length - max));
    let done = false;
    out = mapUntrustedBlocks(out, (content) => {
      if (done || content !== largest.content) return content;
      done = true;
      return content.slice(0, keep);
    });
  }
  return out;
}

/**
 * What actually leaves for the provider (#2026): the system prompt with the
 * untrusted-data rule appended, the input with contact details masked inside
 * its untrusted blocks (unless the task declares `needsContactDetails`), and
 * the tripwire's signals over those blocks. Exported for the unit test.
 */
export function preparePrompt(call: Pick<ModelCall, 'task' | 'system' | 'input'>): { system: string; input: string; flags: string[] } {
  const spec: AiTaskSpec = AI_TASKS[call.task];
  if (untrustedBlocks(call.input).length === 0) throw new UnfencedInputError(call.task);
  const masked = spec.needsContactDetails ? call.input : mapUntrustedBlocks(call.input, (content) => redactForPrompt(content));
  const input = fitToBudget(masked, spec.maxInputChars);
  const flags = [...new Set(untrustedBlocks(call.input).flatMap((b) => injectionSignals(b.content)))];
  if (flags.length) console.warn('[ai] injection tripwire', { task: call.task, flags });
  return { system: `${call.system}\n\n${UNTRUSTED_DATA_RULE}`, input, flags };
}

/**
 * One request to the model under the task's registry entry. Returns the text
 * of the reply ('' when there is none — the caller's parser decides what that
 * means). Throws what the SDK throws; `callProvider` decides about retries.
 */
export async function callModel(call: ModelCall, create: ModelCreate = defaultCreate): Promise<string> {
  const spec: AiTaskSpec = AI_TASKS[call.task];
  const model = resolveModel(call.task);
  const { system, input, flags } = preparePrompt(call);
  const store = callTracking.getStore();
  const usage: AiCallUsage = store?.usage ?? { provider: AI_PROVIDER, model, inputTokens: 0, outputTokens: 0, latencyMs: 0, completed: 0, flags: [] };
  usage.model = model;
  usage.flags = [...new Set([...usage.flags, ...flags])];
  if (store) store.usage = usage;

  const maxTokens = Math.min(call.maxTokens ?? spec.maxOutputTokens, spec.maxOutputTokens);
  const started = Date.now();
  const res = await create({
    model,
    max_tokens: maxTokens,
    system,
    ...(call.jsonSchema ? { output_config: { format: { type: 'json_schema', schema: call.jsonSchema } } } : {}),
    messages: [{ role: 'user', content: input.slice(0, spec.maxInputChars) }],
  });
  usage.latencyMs += Date.now() - started;
  usage.model = res.model || model;
  usage.inputTokens += res.usage?.input_tokens ?? 0;
  usage.outputTokens += res.usage?.output_tokens ?? 0;
  usage.completed += 1;

  const block = res.content.find((b) => b.type === 'text');
  return block && block.type === 'text' ? block.text : '';
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Mark the running call parse_error from a parser that is not
 * safeParseModelJson (e.g. one that also verifies the reply against its
 * input). runAiGated then meters it as parse_error and keeps no artefact.
 */
export function noteParseError(): void {
  const store = callTracking.getStore();
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
    const store = callTracking.getStore();
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
