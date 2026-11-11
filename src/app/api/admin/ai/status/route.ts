import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { loadAiStatus } from '@/lib/ai/console';

// GET — the AI provider's state for the admin console (#2030): whether a
// provider key is configured (yes/no, never the key), the model each task
// resolves to, this container's circuit breaker, the quota, and how many calls
// the injection tripwire flagged in the last 30 days (#2026). ADMIN only,
// checked here.

export async function GET(request: Request) {
  const gate = await requirePermission('org.settings.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  return await withTenantScope(session, async () => NextResponse.json(await loadAiStatus(await settingsOrgOf(session)), { headers: { 'Cache-Control': 'no-store' } }));
}
