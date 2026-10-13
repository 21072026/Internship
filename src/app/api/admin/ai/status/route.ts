import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { loadAiStatus } from '@/lib/ai/console';

// GET — the AI provider's state for the admin console (#2030): whether a
// provider key is configured (yes/no, never the key), the model each task
// resolves to, this container's circuit breaker, the quota, and how many calls
// the injection tripwire flagged in the last 30 days (#2026). ADMIN only,
// checked here.

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  return await withTenantScope(session, async () => NextResponse.json(await loadAiStatus(await settingsOrgOf(session)), { headers: { 'Cache-Control': 'no-store' } }));
}
