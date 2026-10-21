import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { getLocale } from '@/i18n/server';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { acceptAgreement, AgreementWriteError } from '@/lib/mentoringAgreement';

// POST { version } — the caller accepts the mentoring agreement for their own
// side of this pairing (#1792). Only the relation's mentor or mentee: an ADMIN
// is refused (403) even though they can read the relation — an acceptance
// somebody else clicked is worthless as evidence. A superseded version is 409.
// Idempotent: a second POST returns the first row, `acceptedAt` unchanged.
const schema = z.object({ version: z.string().min(1).max(32) }).strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', code: 'invalid' }, { status: 400 });
  return withTenantScope(session, async () => {
    const { id } = await params;
    const relation = await prisma.mentorshipRelation.findFirst({ where: withinTenant({ id }, await tenantWhere(session)), select: { id: true, mentorId: true, menteeId: true } });
    if (!relation) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (relation.mentorId !== session.user.id && relation.menteeId !== session.user.id) {
      return NextResponse.json({ error: 'Only the two people in the pairing accept their own side', code: 'not_a_party' }, { status: 403 });
    }
    try {
      const row = await acceptAgreement({ relationId: relation.id, userId: session.user.id, version: parsed.data.version, locale: await getLocale(), request });
      return NextResponse.json({ acceptance: { version: row.version, role: row.role, acceptedAt: row.acceptedAt } }, { status: 201 });
    } catch (error) {
      if (error instanceof AgreementWriteError) return NextResponse.json({ error: error.code, code: error.code }, { status: error.status });
      throw error;
    }
  });
}
