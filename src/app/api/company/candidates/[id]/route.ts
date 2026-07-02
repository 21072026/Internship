import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

// GET — read-only candidate detail for a COMPANY user (EPIC: company
// candidate detail). Authorized only when a mentorship relation links this
// candidate to the requester's company. Exposes the fields a company needs to
// evaluate a candidate — no email/phone (those stay mentor/admin-only, as in
// the existing company candidates list).
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'COMPANY' || !session.user.companyId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { id } = await params;
  const relation = await prisma.mentorshipRelation.findFirst({
    where: { companyId: session.user.companyId, menteeId: id },
    select: {
      pipelineStatus: true,
      mentor: { select: { fullName: true } },
    },
  });
  if (!relation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const candidate = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      fullName: true,
      avatarUrl: true,
      university: true,
      department: true,
      graduationYear: true,
      city: true,
      bio: true,
      targetPosition: true,
      skills: true,
      skillLevels: true,
      cvUrl: true,
      linkedinUrl: true,
      githubUrl: true,
      portfolioUrl: true,
    },
  });
  if (!candidate) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({
    candidate: { ...candidate, pipelineStatus: relation.pipelineStatus, mentorName: relation.mentor.fullName },
  });
}
