import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere } from '@/lib/tenantFilter';
import { requirePermission } from '@/lib/authz';
import { matchableCustomFields, type CustomAnswerDb } from '@/lib/matching/customAnswers';

// GET — the org's matchable admin-defined questions (#1803): key, type and
// labels only, so a score breakdown can name `customField:<key>` by its label.
// The rule editor reads the same list off GET /api/admin/matching/rule-sets.

export async function GET(request: Request) {
  const gate = await requirePermission('program.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  return withTenantScope(session, async () =>
    NextResponse.json({ customFields: await matchableCustomFields(prisma as unknown as CustomAnswerDb, await tenantWhere(session)) }),
  );
}
