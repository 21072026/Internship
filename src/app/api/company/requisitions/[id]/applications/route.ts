import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { Prisma } from '@prisma/client';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { resolveOrgId } from '@/lib/orgScope';
import { APPLICATION_STAGES, type ApplicationStage } from '@/lib/applications';
import { visibleApplicationsWhere } from '@/lib/applicationStage';
import { answerPath, answeredCount, columnsToLoad, matchedSkills, parseBoardFilters } from '@/lib/requisitionBoard';
import { getServerDictionary } from '@/i18n/server';
import { applicantFits } from '@/lib/requisitionFitApplicants';
import { ruleFitReason } from '@/lib/matching/fitReason';
import { recordRequisitionFits } from '@/lib/requisitionFitStore';

// GET — one requisition's applicant board (#1838): every application to it,
// grouped by stage, with a per-stage count and DB-side pagination per column.
//
// Scoping is the handler's: a COMPANY reads only a requisition its own company
// owns and an ADMIN only one of its org; anything else is a 404, never a 403
// that would confirm the id (#2542). Rows go through visibleApplicationsWhere()
// on top, the one visibility filter for applications.
//
// Every filter runs in SQL. The counts are a `groupBy` over the same filter the
// rows are sliced from, never the length of a loaded page. `?column=<STAGE>`
// pages through one column and skips the counts, so loading page 2 of a column
// does not re-read the whole role.
//
// The candidate fields here are the ones the company candidate detail already
// shows — name and city. No e-mail, no phone.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const capGate = await requireCapability(session.user.orgId, 'placements');
    if (capGate) return capGate;
    const role = session.user.role;
    if (role !== 'COMPANY' && role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'Organization is required', code: 'organization_required' }, { status: 403 });
    const scope = visibleApplicationsWhere({ id: session.user.id, role, orgId, companyId: session.user.companyId ?? null });
    if (!scope) return NextResponse.json({ error: 'Company assignment is required', code: 'company_not_assigned' }, { status: 403 });
    const parsed = parseBoardFilters(new URL(request.url).searchParams);
    if (!parsed.ok) return NextResponse.json({ error: 'Invalid filter', code: parsed.code }, { status: 400 });
    const filters = parsed.filters;
    const { id } = await params;

    return withTenantScope(session, async () => {
      const requisition = await prisma.requisition.findFirst({
        where: { id, orgId, ...(role === 'COMPANY' ? { companyId: session.user.companyId! } : {}) },
        select: { id: true, title: true, status: true, openings: true, filled: true, requiredSkills: true },
      });
      if (!requisition) return NextResponse.json({ error: 'Not found' }, { status: 404 });

      // `skills` is a JSON array; MySQL can still match inside its text form.
      // Bounded by the one requisition, so this reads ids, not candidates.
      let skillIds: string[] | null = null;
      if (filters.skill) {
        const needle = filters.skill.toLowerCase().replace(/["\\,]/g, '').replace(/[%_]/g, (c) => `\\${c}`);
        const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
          SELECT a.id FROM Application a JOIN User u ON u.id = a.menteeId
          WHERE a.requisitionId = ${requisition.id} AND LOWER(CAST(u.skills AS CHAR)) LIKE ${`%${needle}%`}
        `);
        skillIds = rows.map((r) => r.id);
      }

      const where: Prisma.ApplicationWhereInput = {
        AND: [
          scope,
          { requisitionId: requisition.id },
          ...(skillIds ? [{ id: { in: skillIds } }] : []),
          ...(filters.q ? [{ mentee: { fullName: { contains: filters.q } } }] : []),
          ...(filters.city ? [{ mentee: { city: { contains: filters.city } } }] : []),
          ...filters.answers.map((a) => ({ screeningAnswers: { path: answerPath(a.questionId), equals: a.value } })),
        ],
      };

      let counts: Record<ApplicationStage, number> | null = null;
      if (!filters.column) {
        const grouped = await prisma.application.groupBy({ by: ['stage'], where, _count: { _all: true } });
        counts = Object.fromEntries(APPLICATION_STAGES.map((s) => [s, 0])) as Record<ApplicationStage, number>;
        for (const g of grouped) if (g.stage in counts) counts[g.stage as ApplicationStage] = g._count._all;
      }

      const skip = (filters.page - 1) * filters.pageSize;
      const columns: Partial<Record<ApplicationStage, { items: unknown[]; page: number; hasMore: boolean }>> = {};
      await Promise.all(
        columnsToLoad(filters).map(async (stage) => {
          if (counts && counts[stage] === 0) { columns[stage] = { items: [], page: filters.page, hasMore: false }; return; }
          const rows = await prisma.application.findMany({
            where: { AND: [where, { stage }] },
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            skip,
            take: filters.pageSize + 1,
            select: {
              id: true, stage: true, source: true, dispositionCode: true, screeningAnswers: true, createdAt: true, updatedAt: true,
              mentee: { select: { id: true, fullName: true, city: true, skills: true } },
            },
          });
          columns[stage] = {
            page: filters.page,
            hasMore: rows.length > filters.pageSize,
            items: rows.slice(0, filters.pageSize).map(({ screeningAnswers, mentee, ...row }) => ({
              ...row,
              mentee: { id: mentee.id, fullName: mentee.fullName, city: mentee.city },
              matchedSkills: matchedSkills(mentee.skills, requisition.requiredSkills),
              answered: answeredCount(screeningAnswers),
            })),
          };
        }),
      );

      // The written fit reason per applicant (#2042). A SENTENCE only — the
      // score, weights and breakdown are the operator's view and never reach
      // this response. The deterministic sentence is always there; an AI one
      // (written on request through /fit-reasons, the company's AI pack) is
      // shown instead while it was written for the same numbers.
      const shownIds = Object.values(columns).flatMap((c) => (c?.items ?? []) as { mentee: { id: string } }[]).map((i) => i.mentee.id);
      if (shownIds.length > 0) {
        const { t, locale } = await getServerDictionary();
        const { role, fits, label } = await applicantFits(orgId, requisition, shownIds, locale);
        await recordRequisitionFits(orgId, requisition.id, Array.from(fits, ([menteeId, fit]) => ({ menteeId, fit })));
        const stored = new Map(
          (
            await prisma.requisitionFit.findMany({
              where: { orgId, requisitionId: requisition.id, menteeId: { in: shownIds }, reasonSource: 'AI' },
              select: { menteeId: true, reason: true, score: true, ruleSetVersion: true },
            })
          ).map((r) => [r.menteeId, r])
        );
        for (const column of Object.values(columns)) {
          for (const item of (column?.items ?? []) as { mentee: { id: string }; fitReason?: { text: string; source: 'AI' | 'RULE' } }[]) {
            const fit = fits.get(item.mentee.id);
            if (!fit) continue;
            const ai = stored.get(item.mentee.id);
            item.fitReason =
              ai?.reason && ai.score === fit.score && ai.ruleSetVersion === fit.ruleSetVersion
                ? { text: ai.reason, source: 'AI' }
                : { text: ruleFitReason(fit, role, label, t.requisitionPipeline.fit), source: 'RULE' };
          }
        }
      }

      return NextResponse.json({ requisition, counts, columns });
    });
  });
}
