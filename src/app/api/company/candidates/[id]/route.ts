import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { hasFeature } from '@/lib/entitlements';

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

  return await withTenantScope(session, async () => {
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

  // Premium "verified candidate card" (Faz 1, #529): mentor-authored
  // evaluations + the candidate's project contributions, surfaced only when the
  // company holds the VERIFIED_CANDIDATE_CARD entitlement. Absent otherwise, so
  // the free experience is unchanged. Scoped to relations that link this
  // candidate to *this* company — never another company's private evaluations.
  let verified = null;
  if (await hasFeature(session.user.companyId, 'VERIFIED_CANDIDATE_CARD')) {
    const relations = await prisma.mentorshipRelation.findMany({
      where: { companyId: session.user.companyId, menteeId: id },
      select: {
        evaluations: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            type: true,
            scores: true,
            comment: true,
            createdAt: true,
            relation: { select: { mentor: { select: { fullName: true } } } },
          },
        },
        project: {
          select: {
            id: true,
            name: true,
            description: true,
            technologies: true,
            repoUrl: true,
            demoUrl: true,
            status: true,
            tasks: { select: { done: true } },
          },
        },
      },
    });

    const evaluations = relations.flatMap((r) =>
      r.evaluations.map((e) => ({
        id: e.id,
        type: e.type,
        scores: e.scores,
        comment: e.comment,
        createdAt: e.createdAt,
        authorName: e.relation.mentor.fullName,
      }))
    );

    // De-duplicate projects (multiple relations can point at the same project).
    const projectMap = new Map<string, unknown>();
    for (const r of relations) {
      if (r.project && !projectMap.has(r.project.id)) {
        const { tasks, ...rest } = r.project;
        projectMap.set(r.project.id, {
          ...rest,
          tasksTotal: tasks.length,
          tasksDone: tasks.filter((tk) => tk.done).length,
        });
      }
    }

    verified = { evaluations, projects: Array.from(projectMap.values()) };
  }

  return NextResponse.json({
    candidate: { ...candidate, pipelineStatus: relation.pipelineStatus, mentorName: relation.mentor.fullName },
    verified,
  });
  });
}
