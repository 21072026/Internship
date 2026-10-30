import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { enforceRateLimit } from '@/lib/rateLimit';
import { domainPublishesProof } from '@/lib/companyDomainProof';
import { notifyEvent } from '@/lib/notifications/router';

// POST /api/company/onboarding/domain-proof (#1865) — "check my DNS record".
// A PENDING company whose sign-up domain publishes its proof record becomes
// VERIFIED without waiting for an admin. Only PENDING: an admin's rejection or
// suspension is a person's decision and a DNS record does not overturn it.
// The domain looked up is the stored `signupDomain`, never one from the body.
// The flip is a guarded `updateMany` on PENDING, audited under the company user
// who asked; `verifiedById` stays NULL, because no admin cleared it.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'COMPANY') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const companyId = session.user.companyId;
  const orgId = resolveOrgId(session);
  if (!companyId || !orgId) return NextResponse.json({ error: 'Company assignment is required', code: 'company_not_assigned' }, { status: 403 });
  // A DNS lookup per click; a person needs a handful, a loop needs none.
  const limited = enforceRateLimit(request, 'company-domain-proof', { limit: 10, windowMs: 60 * 60 * 1000, subject: session.user.id });
  if (limited) return limited;

  return withTenantScope(session, async () => {
    const company = await prisma.company.findFirst({ where: { id: companyId, orgId }, select: { id: true, name: true, verificationStatus: true, signupDomain: true } });
    if (!company) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (company.verificationStatus !== 'PENDING' || !company.signupDomain) {
      return NextResponse.json({ error: 'Domain proof is not open for this company', code: 'not_pending' }, { status: 409 });
    }
    if (!(await domainPublishesProof(company.signupDomain, company.id))) {
      return NextResponse.json({ ok: false, code: 'record_not_found' });
    }
    const flipped = await prisma.company.updateMany({
      where: { id: company.id, orgId, verificationStatus: 'PENDING' },
      data: { verificationStatus: 'VERIFIED', verifiedAt: new Date(), verifiedById: null, rejectionReason: null },
    });
    if (flipped.count === 0) return NextResponse.json({ error: 'Company changed meanwhile', code: 'state_conflict' }, { status: 409 });
    await prisma.auditLog.create({
      data: {
        orgId,
        actorId: session.user.id,
        action: 'COMPANY_VERIFICATION',
        targetId: company.id,
        detail: JSON.stringify({ action: 'domain_proof', from: 'PENDING', to: 'VERIFIED', domain: company.signupDomain }),
      },
    });
    const users = await prisma.user.findMany({ where: { orgId, companyId, role: 'COMPANY', isActive: true }, select: { id: true } });
    if (users.length) await notifyEvent(users.map((u) => u.id), 'company.verification.approved', { company: company.name });
    return NextResponse.json({ ok: true, verificationStatus: 'VERIFIED' });
  });
}
