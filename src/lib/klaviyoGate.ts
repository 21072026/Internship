// Who may configure the Klaviyo connector (docs/integrations/klaviyo.md): an
// ADMIN of a MARKETING organization, for that organization only. The org is
// ALWAYS the session's — no route takes an org id from the request — so another
// tenant's connection is unreachable by construction.
//
// Each route still opens with its own getServerSession() (scripts/check-route-auth.mjs);
// this is the second half — role, capability, vertical — shared so the four
// routes cannot drift apart.
import type { Session } from 'next-auth';
import { NextResponse } from 'next/server';
import { requireCapability } from '@/lib/capabilityGate';
import { verticalFor } from '@/lib/verticalContext';

export type KlaviyoGate = { ok: true; orgId: string; userId: string } | { ok: false; response: NextResponse };

export async function klaviyoAdminGate(session: Session | null): Promise<KlaviyoGate> {
  if (!session) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (session.user.role !== 'ADMIN') {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  const orgId = session.user.orgId ?? null;
  const denied = (await requireCapability(orgId, 'companies')) ?? (await requireCapability(orgId, 'pipeline'));
  if (denied) return { ok: false, response: denied };
  if (!orgId || (await verticalFor(orgId)) !== 'MARKETING') {
    return {
      ok: false,
      response: NextResponse.json(
        { code: 'vertical_unavailable', error: 'The Klaviyo connector is part of the marketing product only.' },
        { status: 403 },
      ),
    };
  }
  return { ok: true, orgId, userId: session.user.id };
}
