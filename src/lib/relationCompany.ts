// Which company a MentorshipRelation may point at (#2613, from the #2580 review).
//
// `companyId` arrives as a free string on both relation write paths
// (POST /api/mentorship, PUT /api/mentorship/[id]). With MT_ENFORCE_ISOLATION
// off the org middleware scopes nothing, so an unchecked id attached another
// tenant's company, the write's `include: { company: { select: { name } } }`
// read its name back, and a bad id surfaced as a foreign-key 500 — an existence
// oracle. The target is therefore resolved inside the caller's tenant first:
// another tenant's company and a company that does not exist answer the SAME
// 404 body, and nothing is written.
//
// WHO may change it is decided in the PUT route, not here: ADMIN only, in every
// vertical. The rep's `/sales/accounts` (and a mentor's view of the placement
// company) is built from the companies their relations point at, so an owner
// who could re-point one could open any account in the tenant.
//
// SERVER-ONLY: touches Prisma.

import { NextResponse } from 'next/server';
import type { Session } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';

export const COMPANY_NOT_FOUND = { error: 'Company not found', code: 'company_not_found' } as const;

/**
 * `null` when `companyId` is empty (clearing the company) or a company of the
 * caller's tenant; otherwise the 404 to return as-is.
 */
export async function refuseForeignCompany(
  session: Session,
  companyId: string | null | undefined,
): Promise<NextResponse | null> {
  if (!companyId) return null;
  const company = await prisma.company.findFirst({
    where: withinTenant({ id: companyId }, await tenantWhere(session)),
    select: { id: true },
  });
  return company ? null : NextResponse.json(COMPANY_NOT_FOUND, { status: 404 });
}
