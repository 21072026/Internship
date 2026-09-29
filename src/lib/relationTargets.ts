// What a MentorshipRelation may point at — its company, project and cohort —
// and the refusal when it may not (#2613 for the company, #2618 for the rest).
//
// All three arrive as free strings on the relation write paths
// (POST /api/mentorship, PUT /api/mentorship/[id]). With MT_ENFORCE_ISOLATION
// off the org middleware scopes nothing, so an unchecked id attached another
// tenant's row, a write's `include: { …: { select: { name } } }` read its name
// back, and a bad id surfaced as a foreign-key 500 — an existence oracle. The
// target is therefore resolved inside the caller's tenant first: another
// tenant's row and one that does not exist answer the SAME 404 body, and
// nothing is written.
//
// WHO may change them is decided in the PUT route, not here: ADMIN only, in
// every vertical. Each one grants something the owner does not otherwise have —
// a rep's /sales/accounts is built from their relations' companies, and an
// ACTIVE relation's `projectId` IS project-team membership for both of its
// people (`isProjectMember`, src/lib/projectTeam.ts) — so an owner who could
// re-point one would open an account, or join a project, of their choosing.
// The cohort is the admin's reporting grouping (cohort funnel, program costs).
//
// SERVER-ONLY: touches Prisma.

import { NextResponse } from 'next/server';
import type { Session } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';

export type RelationTarget = 'companyId' | 'projectId' | 'cohortId';

export const RELATION_TARGETS: readonly RelationTarget[] = ['companyId', 'projectId', 'cohortId'];

export const TARGET_NOT_FOUND = {
  companyId: { error: 'Company not found', code: 'company_not_found' },
  projectId: { error: 'Project not found', code: 'project_not_found' },
  cohortId: { error: 'Cohort not found', code: 'cohort_not_found' },
} as const;

export const TARGET_ADMIN_ONLY = {
  companyId: { error: 'Only an admin can change the company', code: 'company_change_admin_only' },
  projectId: { error: 'Only an admin can change the project', code: 'project_change_admin_only' },
  cohortId: { error: 'Only an admin can change the cohort', code: 'cohort_change_admin_only' },
} as const;

async function existsInTenant(session: Session, target: RelationTarget, id: string): Promise<boolean> {
  const tenant = await tenantWhere(session);
  const args = { where: withinTenant({ id }, tenant), select: { id: true } } as const;
  switch (target) {
    case 'companyId':
      return !!(await prisma.company.findFirst(args));
    case 'projectId':
      return !!(await prisma.project.findFirst(args));
    case 'cohortId':
      return !!(await prisma.cohort.findFirst(args));
  }
}

/**
 * `null` when every given target is empty (clearing it) or a row of the
 * caller's tenant; otherwise the 404 for the first one that is not, as-is.
 */
export async function refuseForeignTargets(
  session: Session,
  targets: Partial<Record<RelationTarget, string | null | undefined>>,
): Promise<NextResponse | null> {
  for (const target of RELATION_TARGETS) {
    const id = targets[target];
    if (id && !(await existsInTenant(session, target, id))) {
      return NextResponse.json(TARGET_NOT_FOUND[target], { status: 404 });
    }
  }
  return null;
}
