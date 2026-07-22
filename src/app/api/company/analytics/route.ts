import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

// GET — company-scoped analytics: stage distribution, interest summary and
// basic engagement for the company's linked candidates
// (EPIC: company pipeline analytics, roadmap #370).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'COMPANY' && session.user.role !== 'ADMIN')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // A COMPANY user must be linked to a company; without it there is no scope to
  // apply, so fail closed rather than falling into the unscoped ADMIN branch and
  // leaking every candidate's data. ADMIN sees all (companyId undefined).
  if (session.user.role === 'COMPANY' && !session.user.companyId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const companyId = session.user.role === 'COMPANY' ? session.user.companyId : undefined;

  const relations = await prisma.mentorshipRelation.findMany({
    where: companyId ? { companyId } : {},
    select: {
      id: true,
      pipelineStatus: true,
      menteeId: true,
    },
  });

  if (relations.length === 0) {
    return NextResponse.json({
      funnel: {},
      total: 0,
      interestCounts: { INTERESTED: 0, SHORTLISTED: 0, PASS: 0, pending: 0 },
    });
  }

  const menteeIds = relations.map((r) => r.menteeId);

  // Interest signals from the company across their candidates.
  const interests = await prisma.companyInterest.findMany({
    where: {
      ...(companyId ? { companyId } : {}),
      menteeId: { in: menteeIds },
    },
    select: { menteeId: true, status: true },
  });

  // Funnel: count candidates per pipeline stage.
  const funnel: Record<string, number> = {};
  for (const r of relations) {
    funnel[r.pipelineStatus] = (funnel[r.pipelineStatus] ?? 0) + 1;
  }

  // Interest summary.
  const interestByMentee = new Map(interests.map((i) => [i.menteeId, i.status]));
  const interestCounts = {
    INTERESTED: 0,
    SHORTLISTED: 0,
    PASS: 0,
    pending: 0,
  };
  for (const r of relations) {
    const status = interestByMentee.get(r.menteeId);
    if (status === 'INTERESTED') interestCounts.INTERESTED++;
    else if (status === 'SHORTLISTED') interestCounts.SHORTLISTED++;
    else if (status === 'PASS') interestCounts.PASS++;
    else interestCounts.pending++;
  }

  return NextResponse.json({
    funnel,
    total: relations.length,
    interestCounts,
  });
}
