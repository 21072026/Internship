// The programme filter of the analytics screens (#1652), the server half: the
// pure rule is ./programFilterRule.ts. Reads the parameter AND proves the id is
// a programme of the caller's tenant — another org's id (or a made-up one)
// answers 404 here, before any number is computed, so the filter can never be
// used to read a foreign programme or to probe which ids exist.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withinTenant, type TenantWhere } from '@/lib/tenantFilter';
import { parseProgramParam, type ProgramFilter } from '@/lib/programFilterRule';

export { relationProgramWhere, UNASSIGNED_PROGRAM, type ProgramFilter } from '@/lib/programFilterRule';

export async function resolveProgramFilter(
  raw: string | null,
  tenant: TenantWhere,
): Promise<{ filter: ProgramFilter } | { error: NextResponse }> {
  const filter = parseProgramParam(raw);
  if (!filter) return { error: NextResponse.json({ error: 'Not found', code: 'program_not_found' }, { status: 404 }) };
  if (filter.kind === 'program') {
    const own = await prisma.cohort.findFirst({ where: withinTenant({ id: filter.id }, tenant), select: { id: true } });
    if (!own) return { error: NextResponse.json({ error: 'Not found', code: 'program_not_found' }, { status: 404 }) };
  }
  return { filter };
}
