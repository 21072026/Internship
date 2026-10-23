// Who may read the unassigned lead pool and take a lead from it
// (src/lib/leadClaim.ts): whoever works on /sales — a MENTOR, or an ADMIN in
// sales mode (`hasSalesSurface`) — of a MARKETING organization, for that
// organization only. The org is ALWAYS the session's; no route takes one.
//
// Each route still opens with its own getServerSession() (scripts/check-route-auth.mjs);
// this is the shared second half, so the two routes cannot drift apart.
import type { Session } from 'next-auth';
import { NextResponse } from 'next/server';
import { requireCapability } from '@/lib/capabilityGate';
import { verticalFor } from '@/lib/verticalContext';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { hasSalesSurface } from '@/lib/salesSurface';
import { findLeadOwner } from '@/lib/leadOwner';

export type SalesPoolGate = { ok: true; orgId: string; userId: string } | { ok: false; response: NextResponse };

export async function salesPoolGate(session: Session | null): Promise<SalesPoolGate> {
  if (!session) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const role = session.user.role;
  if (role !== 'MENTOR' && role !== 'ADMIN') return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  const orgId = session.user.orgId ?? null;
  const denied = (await requireCapability(orgId, 'companies')) ?? (await requireCapability(orgId, 'pipeline'));
  if (denied) return { ok: false, response: denied };
  if (!orgId || (await verticalFor(orgId)) !== 'MARKETING' || !hasSalesSurface(role, await shellCapabilities(orgId))) {
    return { ok: false, response: NextResponse.json({ code: 'vertical_unavailable', error: 'Forbidden' }, { status: 403 }) };
  }
  // An active ADMIN/MENTOR row of this org: a deactivated account whose
  // session has not expired yet takes nothing.
  const owner = await findLeadOwner(orgId, session.user.id);
  if (!owner) return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { ok: true, orgId, userId: owner.id };
}
