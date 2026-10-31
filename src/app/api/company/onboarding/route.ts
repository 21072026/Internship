import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { onboardingChecklist } from '@/lib/companySignup';
import { expectedDomainProofRecord } from '@/lib/companyDomainProof';

// GET /api/company/onboarding (#1865) — the COMPANY user's own company: its
// verification state and the onboarding checklist, derived from live data
// (src/lib/companySignup.ts). While the company is PENDING and signed up with a
// domain, the DNS record that would verify it is included — it is the
// company's own token and proves nothing for anybody else.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'COMPANY') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const companyId = session.user.companyId;
  const orgId = resolveOrgId(session);
  if (!companyId || !orgId) return NextResponse.json({ error: 'Company assignment is required', code: 'company_not_assigned' }, { status: 403 });

  return withTenantScope(session, async () => {
    const company = await prisma.company.findFirst({
      where: { id: companyId, orgId },
      select: { logoUrl: true, description: true, industry: true, size: true, verificationStatus: true, rejectionReason: true, signupDomain: true },
    });
    if (!company) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const requisitionCount = await prisma.requisition.count({ where: { orgId, companyId } });
    const checklist = onboardingChecklist({ ...company, requisitionCount });
    const proofOpen = company.verificationStatus === 'PENDING' && !!company.signupDomain;
    return NextResponse.json({
      verificationStatus: company.verificationStatus,
      // The reason is about the company itself and is what makes a refusal actionable.
      rejectionReason: company.verificationStatus === 'VERIFIED' ? null : company.rejectionReason,
      signupDomain: company.signupDomain,
      domainProofRecord: proofOpen ? expectedDomainProofRecord(companyId) : null,
      checklist,
    });
  });
}
