import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/apiKey';

// Public, read-only programmatic API authenticated with a Bearer API key.
// Returns a candidate (mentee) summary — no contact PII.
//
// Everything about the credential — is it live, does it hold `candidates:read`,
// which organisation is it — is decided by withApiKey() before this body runs
// (#1546). What is left here is the query, and the query is scoped EXPLICITLY
// by the key's org: the tenant middleware only engages when
// MT_ENFORCE_ISOLATION is on, and a cross-tenant read must not wait for a flag.
export async function GET(request: Request) {
  return withApiKey(request, 'candidates:read', async (key) => {
    const mentees = await prisma.user.findMany({
      where: { role: 'MENTEE', orgId: key.orgId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        fullName: true,
        university: true,
        department: true,
        graduationYear: true,
        skills: true,
        menteeRelations: { where: { status: 'ACTIVE' }, take: 1, select: { pipelineStatus: true } },
      },
    });

    const data = mentees.map((m) => ({
      id: m.id,
      fullName: m.fullName,
      university: m.university,
      department: m.department,
      graduationYear: m.graduationYear,
      skills: m.skills,
      stage: m.menteeRelations[0]?.pipelineStatus ?? null,
    }));
    return NextResponse.json({ candidates: data });
  });
}
