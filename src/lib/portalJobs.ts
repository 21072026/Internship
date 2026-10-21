// The mentee-facing job board (#1830): which requisitions a mentee may see and
// what of them leaves the server. One rule for the list and the detail read.
//
// VISIBLE = OPEN and a seat still free (filled < openings, a column comparison
// in the WHERE so counts and pages stay right — the talent-pool discipline),
// in the caller's org. Everything else — DRAFT, ON_HOLD, FILLED, CANCELLED, a
// full role, another org's role — is simply absent: the detail answers 404.
//
// The select is what the card and the detail render — never ownerId, never the
// legacy CompanyNeed link, never the fill bookkeeping beyond openings/filled.
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export const PORTAL_JOB_SELECT = {
  id: true,
  title: true,
  description: true,
  city: true,
  workMode: true,
  startDate: true,
  requiredSkills: true,
  openings: true,
  filled: true,
  company: { select: { id: true, name: true, logoUrl: true } },
} satisfies Prisma.RequisitionSelect;

export function visibleJobsWhere(orgId: string): Prisma.RequisitionWhereInput {
  return { orgId, status: 'OPEN', filled: { lt: prisma.requisition.fields.openings } };
}

/** Requisition ids whose required skills mention `skill` (case-insensitive) — the JSON array matched in SQL, inside the visible set. */
export async function jobIdsWithSkill(orgId: string, skill: string): Promise<string[]> {
  const needle = skill.toLowerCase().replace(/["\\,]/g, '').replace(/[%_]/g, (c) => `\\${c}`);
  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM Requisition
    WHERE orgId = ${orgId} AND status = 'OPEN' AND filled < openings
      AND LOWER(CAST(requiredSkills AS CHAR)) LIKE ${`%${needle}%`}
  `);
  return rows.map((r) => r.id);
}
