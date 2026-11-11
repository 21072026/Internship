import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { z } from 'zod';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { logActivity } from '@/lib/activity';
import { loadAiPolicy, saveAiPolicy } from '@/lib/ai/policy';
import { isAiTaskId } from '@/lib/ai/tasks';
import { normalizeQuotaOverride } from '@/lib/ai/policyRule';

// The organisation's AI switches (#2032): the kill switch, and per registered
// task an on/off and an optional monthly allowance of its own. ADMIN only,
// checked here; the org is the session's (settingsOrgOf), never a request
// value — a tenant admin reads and writes exactly their own rows. Enforcement
// is server-side in runAiGated (src/lib/aiGate.ts), which reads the same chain
// (src/lib/ai/policy.ts); this route is only where the chain is edited.

export async function GET(request: Request) {
  const gate = await requirePermission('org.settings.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  return await withTenantScope(session, async () => NextResponse.json(await loadAiPolicy(await settingsOrgOf(session)), { headers: { 'Cache-Control': 'no-store' } }));
}

const schema = z
  .object({
    enabled: z.boolean().optional(),
    tasks: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            enabled: z.boolean().optional(),
            // null clears the override (inherit the org quota); a whole number sets it.
            monthlyQuota: z.union([z.number(), z.string(), z.null()]).optional(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
  })
  .strict();

export async function PUT(request: Request) {
  const gate = await requirePermission('org.settings.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const tasks: Array<{ id: string; enabled?: boolean; monthlyQuota?: number | null }> = [];
  for (const task of parsed.data.tasks ?? []) {
    // A task outside the registry is a 400, not a silent skip: the UI only ever sends registry ids.
    if (!isAiTaskId(task.id)) return NextResponse.json({ error: 'Unknown task', code: 'unknown_task' }, { status: 400 });
    const row: { id: string; enabled?: boolean; monthlyQuota?: number | null } = { id: task.id };
    if (task.enabled !== undefined) row.enabled = task.enabled;
    if (task.monthlyQuota !== undefined) {
      const quota = normalizeQuotaOverride(task.monthlyQuota);
      if (!quota.ok) return NextResponse.json({ error: 'Invalid quota', code: 'invalid_quota' }, { status: 400 });
      row.monthlyQuota = quota.value;
    }
    tasks.push(row);
  }

  return await withTenantScope(session, async () => {
    const orgId = await settingsOrgOf(session);
    await saveAiPolicy(orgId, { enabled: parsed.data.enabled, tasks });
    await logActivity({ action: 'settings.update', actorId: session.user.id, actorEmail: session.user.email ?? null });
    return NextResponse.json(await loadAiPolicy(orgId), { headers: { 'Cache-Control': 'no-store' } });
  });
}
