// What every /api/admin/nudges route runs after its own permission check
// (#1686). Each handler calls `requirePermission('org.settings.write')` itself
// — the same guard as the stage-automation routes (#1704), visible in the
// handler so the OpenAPI analyser (and a reader) can see it: a rule is org
// configuration that mails the org's people, so a MENTOR or MENTEE calling the
// API gets 403 from the route, not a hidden button. This adds the `mentorship`
// capability — a nudge's audience exists only where mentorship does — and
// answers the caller's org.
import type { NextResponse } from 'next/server';
import type { Session } from 'next-auth';
import { requireCapability } from '@/lib/capabilityGate';
import { settingsOrgOf } from '@/lib/settingsOrg';

export async function nudgeScope(session: Session): Promise<{ error: NextResponse } | { orgId: string; userId: string; email: string | null }> {
  const orgId = await settingsOrgOf(session);
  const refusal = await requireCapability(orgId, 'mentorship');
  if (refusal) return { error: refusal };
  return { orgId, userId: session.user.id, email: session.user.email ?? null };
}
