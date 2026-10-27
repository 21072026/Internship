import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { resolveOrgId } from '@/lib/orgScope';
import { getLocale } from '@/i18n/server';
import { loadSkillEdges, skillLabels } from '@/lib/skillsResolve';
import { CONSENTING_POOL_WHERE, rankRequisitionMatches } from '@/lib/requisitionMatchRule';

// GET — the candidates who fit one requisition (#1401), for the admin's
// requisition detail. The rule is requisitionMatchRule.ts, the same one the
// premium match-alert cron applies, and only the CONSENTING talent pool of the
// requisition's org is ever read — a candidate without consent is not offered
// for a shortlist the company will see.
//
// ADMIN only, through requirePermission('user.read'): this lists people. A
// COMPANY reads its own applicants on /api/company/requisitions/[id]/applications
// and never this list; a requisition of another org is a 404.
//
// Each match carries why it matched (the required skills it holds, the related
// skill standing in for a missing one, or the title fallback) and the stage of
// an application the candidate already has to this role, so the screen offers
// "add to shortlist" only where it would do something.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const auth = await requirePermission('user.read', { request });
    if ('error' in auth) return auth.error;
    const { session } = auth;
    const capGate = await requireCapability(session.user.orgId, 'placements');
    if (capGate) return capGate;
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'Organization is required', code: 'organization_required' }, { status: 403 });
    const { id } = await params;

    return withTenantScope(session, async () => {
      const requisition = await prisma.requisition.findFirst({
        where: { id, orgId },
        select: {
          id: true, title: true, status: true, openings: true, filled: true, requiredSkills: true, city: true,
          company: { select: { id: true, name: true } },
          skills: { select: { skillId: true } },
        },
      });
      if (!requisition) return NextResponse.json({ error: 'Not found' }, { status: 404 });

      const requiredSkillIds = requisition.skills.map((s) => s.skillId);
      const [pool, edges, applications] = await Promise.all([
        prisma.user.findMany({
          where: { ...CONSENTING_POOL_WHERE, orgId },
          select: { id: true, targetPosition: true, skillRows: { select: { skillId: true } } },
        }),
        loadSkillEdges(orgId, requiredSkillIds),
        prisma.application.findMany({ where: { orgId, requisitionId: requisition.id }, select: { id: true, menteeId: true, stage: true } }),
      ]);
      const ranked = rankRequisitionMatches(
        { title: requisition.title, requiredSkillIds },
        pool.map((p) => ({ id: p.id, targetPosition: p.targetPosition, skillIds: p.skillRows.map((r) => r.skillId) })),
        edges,
      );

      const ids = ranked.map((m) => m.candidateId);
      const people = ids.length
        ? await prisma.user.findMany({ where: { id: { in: ids }, orgId }, select: { id: true, fullName: true, city: true, targetPosition: true } })
        : [];
      const personOf = new Map(people.map((p) => [p.id, p]));
      const applicationOf = new Map(applications.map((a) => [a.menteeId, a]));
      const labels = await skillLabels(
        orgId,
        ranked.flatMap((m) => [...m.direct, ...m.adjacent.flatMap((a) => [a.skillId, a.via])]),
        await getLocale(),
      );
      const label = (skillId: string) => labels.get(skillId) ?? skillId;

      const matches = ranked.flatMap((m) => {
        const person = personOf.get(m.candidateId);
        if (!person) return [];
        const application = applicationOf.get(m.candidateId);
        return [{
          candidate: person,
          via: m.via,
          score: m.score,
          direct: m.direct.map(label),
          adjacent: m.adjacent.map((a) => ({ skill: label(a.skillId), via: label(a.via) })),
          application: application ? { id: application.id, stage: application.stage } : null,
        }];
      });

      return NextResponse.json({
        requisition: {
          id: requisition.id, title: requisition.title, status: requisition.status, openings: requisition.openings,
          filled: requisition.filled, requiredSkills: requisition.requiredSkills, city: requisition.city, company: requisition.company,
          canonicalSkillCount: requiredSkillIds.length,
        },
        matches,
      });
    });
  });
}
