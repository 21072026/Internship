// The AI policy chain (#2032), dependency-free: how an organisation's switches
// and quotas combine into one answer for one task. `src/lib/ai/policy.ts` reads
// the rows and calls this; `scripts/test/ai-policy.test.mjs` loads this file
// under `node --test` with no database.
//
// THE CHAIN, in order, and nothing else decides:
//   1. the org kill switch (`aiEnabled` Setting) — off means every task is off,
//      whatever the rows below say;
//   2. the per-task switch (`AiFeatureSetting.enabled`) — off means this task is
//      off; no row means on;
//   3. the per-task quota (`AiFeatureSetting.monthlyQuota`) — when set, THIS
//      task's own monthly allowance, counted against this task's own calls;
//   4. the org quota (`aiMonthlyQuota`, the tenant's Setting row);
//   5. the global default (the deployment's global Setting row, then the code
//      default) — steps 4 and 5 are what `getSetting()` resolves in one read.
//
// "Disabled" and "quota exhausted" are DIFFERENT denials on purpose: the first
// is a decision an admin made, the second a budget that ran out, and the
// screen must say which (docs/ai.md § The degradation contract).

export interface AiTaskSettingRow {
  enabled: boolean;
  /** This task's own monthly allowance; null inherits the org quota. */
  monthlyQuota: number | null;
}

export interface AiPolicyInput {
  /** The `aiEnabled` Setting as stored: 'false' is off, anything else on. */
  aiEnabled: string | null | undefined;
  /** The `aiMonthlyQuota` Setting as resolved for the org (tenant → global → default). */
  orgQuota: string | number | null | undefined;
  /** The task's own row, or null when the org never touched this task. */
  task: AiTaskSettingRow | null;
}

export interface AiPolicy {
  /** The org kill switch. */
  enabled: boolean;
  /** The task after both switches: false when the org or the task is off. */
  taskEnabled: boolean;
  /** The monthly allowance that applies to this task, in answered calls. */
  quota: number;
  /** Whose counter the allowance is measured against. */
  quotaSource: 'task' | 'org';
}

/** 'false' (any case, trimmed) is off; everything else — including an unset row — is on. */
export function isAiOn(value: string | null | undefined): boolean {
  return (value ?? '').trim().toLowerCase() !== 'false';
}

/** A quota as stored: a non-negative whole number; anything unreadable is 0 (AI off). */
export function parseQuota(raw: string | number | null | undefined): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function resolvePolicyChain(input: AiPolicyInput): AiPolicy {
  const enabled = isAiOn(input.aiEnabled);
  const taskEnabled = enabled && (input.task?.enabled ?? true);
  if (input.task && input.task.monthlyQuota !== null && input.task.monthlyQuota !== undefined) {
    return { enabled, taskEnabled, quota: parseQuota(input.task.monthlyQuota), quotaSource: 'task' };
  }
  return { enabled, taskEnabled, quota: parseQuota(input.orgQuota), quotaSource: 'org' };
}

/** The bound on a quota a form may store — the same width `aiMonthlyQuota` accepts (six digits). */
export const MAX_AI_QUOTA = 999_999;

/** A per-task quota from a form: null clears the override, a whole number 0..MAX sets it, anything else is refused. */
export function normalizeQuotaOverride(raw: unknown): { ok: true; value: number | null } | { ok: false } {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,6}$/.test(raw.trim()) ? parseInt(raw.trim(), 10) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > MAX_AI_QUOTA) return { ok: false };
  return { ok: true, value: n };
}
