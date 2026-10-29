import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { entitled } from '@/lib/entitlements';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { tenantWhere } from '@/lib/tenantFilter';
import { defaultOrgId } from '@/lib/defaultOrg';
import { requireCapability } from '@/lib/capabilityGate';
import { getLocale } from '@/i18n/server';
import { skillLabel } from '@/lib/skillTaxonomyRule';
import { buildSkillsGap } from '@/lib/skillsGapRule';

// GET — the skills-gap report (#1823): what the programme's mentees hold
// (supply) against what HIRING requisitions require (demand), per canonical
// skill. Every definition — hiring, weighting, gap, coverage — lives in
// `src/lib/skillsGapRule.ts`; this route only loads rows and attaches labels.
//
// ADMIN only, decided here (hiding the panel is not a control); a vertical
// without the `mentorship` module is refused like the cohort card; premium
// through the ONE entitlement resolver (#1740), ADVANCED_ANALYTICS — no second
// gate. Tenant-scoped by hand (`tenantWhere`) as well as by the scope, because
// the middleware is dormant unless MT_ENFORCE_ISOLATION is on.
//
// `?cohortId=` narrows SUPPLY to the mentees of that cohort's relations;
// demand stays the org's hiring requisitions (a requisition has no cohort).
export async function GET(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const callerOrgId = (session.user as { orgId?: string | null }).orgId ?? null;
    const gated = await requireCapability(callerOrgId, 'mentorship');
    if (gated) return gated;
    if (!(await entitled(await settingsOrgOf(session), 'ADVANCED_ANALYTICS'))) {
      return NextResponse.json({ error: 'feature_locked', code: 'feature_locked', feature: 'ADVANCED_ANALYTICS' }, { status: 403 });
    }
    const params = new URL(request.url).searchParams;
    const cohortId = params.get('cohortId') || null;
    // `all=1`: every skill row too — what the export writes (#1823). The panel
    // reads the two ranked lists only.
    const all = params.get('all') === '1';
    const locale = await getLocale();

    return withTenantScope(session, async () => {
      const tenant = await tenantWhere(session);
      // Requisition.orgId is required, so its org is named outright: the
      // caller's, or the default org for an org-less admin (tenantWhere's rule).
      const reqOrgId = callerOrgId ?? (await defaultOrgId());
      let menteeIds: string[] | null = null;
      if (cohortId) {
        const cohort = await prisma.cohort.findFirst({ where: { id: cohortId, ...tenant }, select: { id: true } });
        // Another tenant's cohort reads exactly like a missing one.
        if (!cohort) return NextResponse.json({ error: 'Not found' }, { status: 404 });
        const rels = await prisma.mentorshipRelation.findMany({ where: { cohortId }, select: { menteeId: true } });
        menteeIds = [...new Set(rels.map((r) => r.menteeId))];
      }

      const [holdings, requisitions] = await Promise.all([
        prisma.userSkill.findMany({
          where: {
            user: { role: 'MENTEE', isActive: true, ...tenant, ...(menteeIds ? { id: { in: menteeIds } } : {}) },
          },
          select: { userId: true, skillId: true, level: true, verifiedAt: true },
        }),
        prisma.requisition.findMany({
          where: { orgId: reqOrgId, status: 'OPEN' },
          select: { id: true, status: true, openings: true, filled: true, skills: { where: { required: true }, select: { skillId: true } } },
        }),
      ]);

      const report = buildSkillsGap(
        holdings.map((h) => ({ userId: h.userId, skillId: h.skillId, level: h.level, verified: h.verifiedAt !== null })),
        requisitions.map((r) => ({ ...r, skillIds: r.skills.map((s) => s.skillId) })),
      );

      const ids = [...new Set([...report.underSupplied, ...report.unused, ...(all ? report.rows : [])].map((r) => r.skillId))];
      const skills = ids.length
        ? await prisma.skill.findMany({ where: { id: { in: ids } }, select: { id: true, labelEn: true, labelTr: true, labelDe: true } })
        : [];
      const labelOf = new Map(skills.map((s) => [s.id, skillLabel(s, locale)]));
      const named = <T extends { skillId: string }>(rows: T[]) => rows.map((r) => ({ ...r, label: labelOf.get(r.skillId) ?? r.skillId }));

      return NextResponse.json({
        underSupplied: named(report.underSupplied),
        unused: named(report.unused),
        coverage: report.coverage,
        hiringRequisitions: report.hiringRequisitions,
        requisitionsWithoutSkills: report.requisitionsWithoutSkills,
        supplyPeople: report.supplyPeople,
        cohortId,
        ...(all ? { rows: named(report.rows) } : {}),
      });
    });
  });
}
