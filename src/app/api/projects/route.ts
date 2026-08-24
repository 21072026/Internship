import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { resolveOwner } from '@/lib/projectAccess';
import { scopeForRole, logScopeDenial } from '@/lib/authzScope';
import { logActivity } from '@/lib/activity';
import { withTenantScope } from '@/lib/orgContext';
import { createOrGetProjectConversation } from '@/lib/conversations';
import { mergeTeam, internCount } from '@/lib/projectTeam';

const include = {
  ownerUser: { select: { id: true, fullName: true, role: true } },
  ownerCompany: { select: { id: true, name: true } },
  tasks: {
    orderBy: { order: 'asc' },
    include: { assignee: { select: { id: true, fullName: true } } },
  },
  // Legacy membership source for the card's "who's on it" row (#616). No `take`
  // here any more: the row is merged with `members` into the team (#51), and a
  // truncated list would silently under-count the interns.
  relations: {
    where: { status: 'ACTIVE' },
    select: {
      mentee: { select: { id: true, fullName: true } },
      mentor: { select: { id: true, fullName: true } },
    },
  },
  members: {
    orderBy: { addedAt: 'asc' },
    select: { role: true, functionalRole: true, addedAt: true, user: { select: { id: true, fullName: true, role: true } } },
  },
  // Filtered relation count: the card shows an owner there is something waiting
  // without loading every request (#51).
  _count: { select: { relations: true, joinRequests: { where: { status: 'PENDING' } } } },
} as const;

// GET — projects visible to the caller (admin: all; mentor: owned; company: their company's).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return withTenantScope(session, async () => {
  // Fail-closed scoping (#849): SOURCE used to fall past the role chain here
  // and read every project, private ones included. Per-role scopes now live in
  // authzScope.ts and an unlisted role is denied instead of unfiltered.
  const where = await scopeForRole(session.user, 'project');
  if (!where) {
    await logScopeDenial(session.user, 'GET /api/projects');
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const projects = await prisma.project.findMany({ where, include, orderBy: { updatedAt: 'desc' } });
  // The card's "who's on it" row and its intern count come from the merged team
  // (members + legacy relations), never from `_count.relations` alone (#51).
  const withTeam = projects.map((p) => {
    const team = mergeTeam(p.members, p.relations);
    return { ...p, team, internCount: internCount(team) };
  });
  // Showcase-only roles (mentee, source) browse the public set — keep it
  // PII-free (names stripped, count only) for projects they are NOT on. A mentee
  // who is a member of the project is a colleague of everyone in it, so they see
  // the roster (they are in the same group chat anyway).
  if (session.user.role === 'MENTEE' || session.user.role === 'SOURCE') {
    return NextResponse.json({
      projects: withTeam.map(({ relations: _relations, members: _members, team, ...rest }) =>
        team.some((m) => m.id === session.user.id) ? { ...rest, team } : rest
      ),
    });
  }
  return NextResponse.json({ projects: withTeam });
  });
}

const schema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(5000).optional().nullable(),
  technologies: z.array(z.string()).max(50).optional(),
  repoUrl: z.string().url().max(500).optional().or(z.literal('')),
  demoUrl: z.string().url().max(500).optional().or(z.literal('')),
  boardUrl: z.string().url().max(500).optional().or(z.literal('')),
  status: z.enum(['DRAFT', 'ACTIVE', 'COMPLETED', 'ARCHIVED', 'CANCELLED']).optional(),
  isPublic: z.boolean().optional(),
  goals: z.string().max(5000).optional().nullable(),
  startDate: z.string().optional().nullable(),
  endDate: z.string().optional().nullable(),
  // Which contributor terms this project's members accept (#1026).
  contributorTermsKey: z.string().max(60).optional().nullable().or(z.literal('')),
  contributorTermsRequired: z.boolean().optional(),
  ownerType: z.enum(['ADMIN', 'MENTOR', 'MENTEE', 'COMPANY']).optional(),
  ownerUserId: z.string().optional().nullable(),
  ownerCompanyId: z.string().optional().nullable(),
});

// POST — create a project. Admin may set any owner; a mentor always owns it.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'ADMIN' && session.user.role !== 'MENTOR')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return withTenantScope(session, async () => {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  // Resolve & authorize ownership (no orphan projects).
  let owner;
  if (session.user.role === 'MENTOR') {
    owner = { ownerType: 'MENTOR' as const, ownerUserId: session.user.id, ownerCompanyId: null };
  } else {
    // ADMIN ownership defaults to the acting admin when no user id is supplied.
    const ownerUserId = d.ownerType === 'ADMIN' ? d.ownerUserId || session.user.id : d.ownerUserId;
    owner = await resolveOwner({ ownerType: d.ownerType, ownerUserId, ownerCompanyId: d.ownerCompanyId });
    if (!owner) return NextResponse.json({ error: 'A valid owner (admin, mentor, mentee or company) is required' }, { status: 400 });
  }

  const project = await prisma.project.create({
    data: {
      // Person owners also get an OWNER member row (#617) so the members
      // table is authoritative from day one.
      ...(owner.ownerUserId ? { members: { create: { userId: owner.ownerUserId, role: 'OWNER' } } } : {}),
      name: d.name,
      description: d.description || null,
      technologies: d.technologies ?? [],
      repoUrl: d.repoUrl || null,
      demoUrl: d.demoUrl || null,
      boardUrl: d.boardUrl || null,
      status: d.status ?? 'ACTIVE',
      isPublic: d.isPublic ?? false,
      goals: d.goals || null,
      startDate: d.startDate ? new Date(d.startDate) : null,
      endDate: d.endDate ? new Date(d.endDate) : null,
      contributorTermsKey: d.contributorTermsKey || null,
      ...(d.contributorTermsRequired !== undefined ? { contributorTermsRequired: d.contributorTermsRequired } : {}),
      ...owner,
    },
    include,
  });
  await createOrGetProjectConversation(project.id);
  await logActivity({ action: 'project.create', actorId: session.user.id, actorEmail: session.user.email ?? null, targetType: 'project', targetId: project.id });
  return NextResponse.json({ project }, { status: 201 });
  });
}
