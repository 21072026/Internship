import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { resolveOrgId } from '@/lib/orgScope';
import { requireRoleOrPermission } from '@/lib/authz';
import { visibleApplicationsWhere } from '@/lib/applicationStage';
import { AI_PACK_FEATURE, runAiGated } from '@/lib/aiGate';
import { enforceRateLimit } from '@/lib/rateLimit';
import { AI_RATE_LIMITS } from '@/lib/ai/limits';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { hashInput } from '@/lib/ai/artifacts';
import { getLocale } from '@/i18n/server';
import { applicantFits, rankByFit } from '@/lib/requisitionFitApplicants';
import { anonLabel, buildFitReasonPayload } from '@/lib/matching/fitReason';
import { aiFitReasons, decodeReasons, encodeReasons } from '@/lib/aiRequisitionFit';
import { recordRequisitionFits } from '@/lib/requisitionFitStore';

// POST — write the AI fit sentences for a requisition's top applicants (#2042).
//
// Who: the same people who read the board — the owning COMPANY, or an ADMIN of
// the org (visibleApplicationsWhere); another company's requisition is a 404.
//
// What it does, in this order, and what it never does:
//   1. scores every visible applicant deterministically (scoreFit) and ranks
//      them — that order is FINAL; nothing below can change it;
//   2. sends the top FIT_REASON_TOP_N as anonymous labels (A, B, C…) built from
//      the breakdown alone (buildFitReasonPayload — no id, name, e-mail, photo
//      or protected characteristic can reach it) through runAiGated, task
//      `requisition_fit`, operator audience → the company's AI pack;
//   3. stores each sentence on its RequisitionFit row (reasonSource AI), which
//      the board then shows in place of the rule-based one.
// No stage moves, no application is touched, nobody is filtered out. Without
// the pack, a provider or quota the board keeps its rule-based sentences and
// this answers which of those it was — never a blank screen, never a 500.

const FIT_REASON_TOP_N = 5;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const capGate = await requireCapability(session.user.orgId, 'placements');
    if (capGate) return capGate;
    const role = session.user.role;
    const gate = await requireRoleOrPermission(['COMPANY'], 'company.write', { request });
    if ('error' in gate) return gate.error;
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'Organization is required', code: 'organization_required' }, { status: 403 });
    const scope = visibleApplicationsWhere({ id: session.user.id, role, orgId, companyId: session.user.companyId ?? null });
    if (!scope) return NextResponse.json({ error: 'Company assignment is required', code: 'company_not_assigned' }, { status: 403 });

    const limited = enforceRateLimit(request, 'ai:requisition_fit', { ...AI_RATE_LIMITS.requisition_fit, subject: session.user.id });
    if (limited) return limited;
    const { id } = await params;

    return withTenantScope(session, async () => {
      const requisition = await prisma.requisition.findFirst({
        where: { id, orgId, ...(role === 'COMPANY' ? { companyId: session.user.companyId! } : {}) },
        select: { id: true, title: true, companyId: true },
      });
      if (!requisition) return NextResponse.json({ error: 'Not found' }, { status: 404 });

      const applicants = await prisma.application.findMany({
        where: { AND: [scope, { requisitionId: requisition.id }] },
        select: { menteeId: true },
      });
      const locale = await getLocale();
      const { role: fitRole, fits, label } = await applicantFits(
        orgId,
        requisition,
        applicants.map((a) => a.menteeId),
        locale
      );
      const top = rankByFit(fits).slice(0, FIT_REASON_TOP_N);
      if (top.length === 0) return NextResponse.json({ ai: 'ok', written: 0 });

      const payload = buildFitReasonPayload(fitRole, top.map((m) => fits.get(m)!), label);
      const gated = await runAiGated({
        scope: 'requisition_fit',
        audience: 'operator',
        orgId: await settingsOrgOf(session),
        userId: session.user.id,
        companyId: requisition.companyId,
        call: () => aiFitReasons(payload, locale),
        // The same anonymous payload in the same language is the same question.
        // The mentee ids are hashed in (never sent) because a label is a
        // position: a stored "A" is only the same person while the order is.
        persist: {
          subjectUserId: null,
          createdById: session.user.id,
          requisitionId: requisition.id,
          inputHash: hashInput({ payload, locale, menteeIds: top }),
          serialize: encodeReasons,
          deserialize: decodeReasons,
        },
      });
      if (!gated.ok) {
        return NextResponse.json({ ai: gated.reason, written: 0, ...(gated.reason === 'not_entitled' ? { locked: AI_PACK_FEATURE } : {}) });
      }

      const records = top.flatMap((menteeId, i) => {
        const text = gated.result.get(anonLabel(i));
        return text ? [{ menteeId, fit: fits.get(menteeId)!, reason: { text, source: 'AI' as const } }] : [];
      });
      await recordRequisitionFits(orgId, requisition.id, records);
      return NextResponse.json({ ai: 'ok', written: records.length });
    });
  });
}
