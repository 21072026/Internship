import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { decide } from '@/lib/authzRule';
import { requireCapability } from '@/lib/capabilityGate';
import { countPendingApplications, listApplications } from '@/lib/affiliateApplicationReview';

// GET ?status=PENDING|APPROVED|REJECTED — the programme's partner applications
// (docs/affiliate-module.md, #3362), newest first, plus the pending count. With
// ?count=1 only the pending count, for the tab's badge. `affiliate.read`, MARKETING only; the org comes from the session.
const STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;

export async function GET(request: Request) {
  const auth = await requirePermission('affiliate.read', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const params = new URL(request.url).searchParams;
  if (params.get('count') === '1') return NextResponse.json({ pending: await countPendingApplications(orgId) });
  const raw = params.get('status');
  const status = (STATUSES as readonly string[]).includes(raw ?? '') ? (raw as (typeof STATUSES)[number]) : null;
  const { rows, pending } = await listApplications(orgId, status);
  const canWrite = decide({ actor: auth.actor, permission: 'affiliate.write' }).allow;
  return NextResponse.json({ applications: rows, pending, canWrite });
}
