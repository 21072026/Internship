// The ONE reader of an organisation's AI settings (#2032): the kill switch,
// the per-task switches, the per-task quotas and the org quota, combined by
// the chain in src/lib/ai/policyRule.ts. The gate (src/lib/aiGate.ts) asks
// `resolveAiPolicy()` before it spends anything; the console (/admin/ai)
// reads and writes through `loadAiPolicy()` / `saveAiPolicy()`. Nothing else
// may read `aiMonthlyQuota` or `aiEnabled` — a second reader is a second
// chain, and the two would disagree one day.

import { prisma } from '@/lib/prisma';
import { getSetting, setSetting } from '@/lib/settings';
import { AI_TASK_IDS, AI_TASKS, isAiTaskId, type AiTaskId } from '@/lib/ai/tasks';
import { resolvePolicyChain, parseQuota, type AiPolicy } from '@/lib/ai/policyRule';

export type { AiPolicy } from '@/lib/ai/policyRule';

/** The chain for one task of one org. */
export async function resolveAiPolicy(orgId: string, taskId: AiTaskId): Promise<AiPolicy> {
  const [aiEnabled, orgQuota, task] = await Promise.all([
    getSetting('aiEnabled', orgId),
    getSetting('aiMonthlyQuota', orgId),
    prisma.aiFeatureSetting.findUnique({ where: { orgId_taskId: { orgId, taskId } }, select: { enabled: true, monthlyQuota: true } }),
  ]);
  return resolvePolicyChain({ aiEnabled, orgQuota, task });
}

/** The org-level allowance (tenant row → global row → default), for the console's budget card. */
export async function orgAiQuota(orgId: string): Promise<number> {
  return parseQuota(await getSetting('aiMonthlyQuota', orgId));
}

export interface AiPolicyTaskView {
  id: AiTaskId;
  label: string;
  audience: 'participant' | 'operator';
  enabled: boolean;
  /** The task's own allowance, or null when it inherits the org quota. */
  monthlyQuota: number | null;
}

export interface AiPolicyView {
  enabled: boolean;
  tasks: AiPolicyTaskView[];
}

/** Every registered task with its switch and override, for the console. */
export async function loadAiPolicy(orgId: string): Promise<AiPolicyView> {
  const [aiEnabled, rows] = await Promise.all([
    getSetting('aiEnabled', orgId),
    prisma.aiFeatureSetting.findMany({ where: { orgId }, select: { taskId: true, enabled: true, monthlyQuota: true } }),
  ]);
  const byTask = new Map(rows.map((r) => [r.taskId, r]));
  return {
    enabled: resolvePolicyChain({ aiEnabled, orgQuota: null, task: null }).enabled,
    tasks: AI_TASK_IDS.map((id) => {
      const row = byTask.get(id);
      return { id, label: AI_TASKS[id].label, audience: AI_TASKS[id].audience, enabled: row?.enabled ?? true, monthlyQuota: row?.monthlyQuota ?? null };
    }),
  };
}

export interface AiPolicyPatch {
  enabled?: boolean;
  tasks?: Array<{ id: string; enabled?: boolean; monthlyQuota?: number | null }>;
}

/**
 * Write the switches. `orgId` is a SERVER-SIDE argument — the session's org,
 * never a request value. A task id outside the registry is ignored rather than
 * stored: a row nobody can read would only confuse the next admin.
 */
export async function saveAiPolicy(orgId: string, patch: AiPolicyPatch): Promise<void> {
  if (patch.enabled !== undefined) await setSetting('aiEnabled', patch.enabled ? 'true' : 'false', orgId);
  for (const task of patch.tasks ?? []) {
    if (!isAiTaskId(task.id)) continue;
    const data = {
      ...(task.enabled !== undefined ? { enabled: task.enabled } : {}),
      ...(task.monthlyQuota !== undefined ? { monthlyQuota: task.monthlyQuota } : {}),
    };
    if (Object.keys(data).length === 0) continue;
    await prisma.aiFeatureSetting.upsert({
      where: { orgId_taskId: { orgId, taskId: task.id } },
      create: { orgId, taskId: task.id, enabled: task.enabled ?? true, monthlyQuota: task.monthlyQuota ?? null },
      update: data,
    });
  }
}
