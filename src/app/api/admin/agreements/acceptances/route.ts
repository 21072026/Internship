import { NextResponse } from 'next/server';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { requireCapability } from '@/lib/capabilityGate';
import { acceptanceReport } from '@/lib/mentoringAgreement';
import { agreementStatusOf } from '@/lib/mentoringAgreementRule';
import { requirePermission } from '@/lib/authz';

// GET — the whole-programme view of the mentoring agreement (#1792): every
// active pairing of the caller's org, each side's acceptance of the version in
// force and the resulting status. The report an HR or legal reviewer asks for.
export async function GET(request: Request) {
  const gate = await requirePermission('content.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const refusal = await requireCapability(session.user.orgId, 'mentorship');
  if (refusal) return refusal;
  return withTenantScope(session, async () => {
    const report = await acceptanceReport(resolveOrgId(session));
    return NextResponse.json({
      version: report.version,
      relations: report.relations.map((r) => ({ ...r, status: agreementStatusOf(r.mentorAcceptedAt, r.menteeAcceptedAt) })),
    });
  });
}
