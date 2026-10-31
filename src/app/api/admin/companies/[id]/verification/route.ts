import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { notifyEvent } from '@/lib/notifications/router';
import { isVerificationAction, verificationTransition } from '@/lib/companyVerification';
import { TEXT_LIMITS } from '@/lib/textLimits';

// POST /api/admin/companies/[id]/verification (#1865) — the admin's decision on
// an employer: approve | reject | suspend | reinstate. Which move exists from
// which status, and when a reason is required, is `verificationTransition()`
// (src/lib/companyVerification.ts); the write is a guarded `updateMany` on the
// status we read, so two admins deciding at once cannot both win (409).
//
// Every decision writes an AuditLog row with the org passed explicitly
// (docs/audit-stream.md) and tells the company's active users in-app — with the
// reason on a refusal, because "rejected" without one is not actionable —
// through the notification router (catalogue entries `company.verification.*`).

const bodySchema = z
  .object({
    action: z.string().refine(isVerificationAction, 'unknown action'),
    reason: z.string().max(TEXT_LIMITS.companyVerificationReason).nullable().optional(),
  })
  .strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('company.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const { id } = await params;
  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
    const blocked = await requireCapability(orgId, 'placements');
    if (blocked) return blocked;

    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    const action = parsed.data.action as Parameters<typeof verificationTransition>[0]['action'];

    const company = await prisma.company.findFirst({ where: { id, orgId }, select: { id: true, name: true, verificationStatus: true } });
    if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 });

    const verdict = verificationTransition({ from: company.verificationStatus, action, reason: parsed.data.reason });
    if (!verdict.ok) return NextResponse.json({ error: 'Verification change refused', code: verdict.code }, { status: 400 });

    const now = new Date();
    const result = await prisma.company.updateMany({
      where: { id, orgId, verificationStatus: company.verificationStatus },
      data: {
        verificationStatus: verdict.to,
        rejectionReason: verdict.reason,
        // Who and when cleared it; a refusal keeps the record of the decision too.
        verifiedAt: now,
        verifiedById: session.user.id,
      },
    });
    if (result.count === 0) return NextResponse.json({ error: 'Company changed meanwhile', code: 'state_conflict' }, { status: 409 });

    await prisma.auditLog.create({
      data: {
        orgId,
        actorId: session.user.id,
        action: 'COMPANY_VERIFICATION',
        targetId: id,
        detail: JSON.stringify({ action, from: company.verificationStatus, to: verdict.to, reason: verdict.reason }),
      },
    });
    await logActivity({
      action: 'company.verification',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'company',
      targetId: id,
      detail: `${company.verificationStatus} → ${verdict.to}`,
      request,
    });

    const users = await prisma.user.findMany({ where: { orgId, companyId: id, role: 'COMPANY', isActive: true }, select: { id: true } });
    const recipients = users.map((u) => u.id);
    if (recipients.length && verdict.to === 'VERIFIED') {
      await notifyEvent(recipients, 'company.verification.approved', { company: company.name });
    } else if (recipients.length && (verdict.to === 'REJECTED' || verdict.to === 'SUSPENDED')) {
      const key = verdict.to === 'REJECTED' ? 'company.verification.rejected' : 'company.verification.suspended';
      await notifyEvent(recipients, key, { company: company.name, reason: verdict.reason ?? '' });
    }

    return NextResponse.json({ ok: true, verificationStatus: verdict.to });
  });
}
