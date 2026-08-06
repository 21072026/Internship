import { prisma } from '@/lib/prisma';
import { mergeTeam, internCount, type TeamMember } from '@/lib/projectTeam';

// ---------------------------------------------------------------------------
// "Which projects do I work on?", answered for a mentee (#1114).
//
// The authorization layer already let a mentee read their own project
// (`scopeForRole('project')` in authzScope.ts) and the detail page already gave
// a member the internal view — but nothing in the portal ever *linked* there:
// the sidebar had no entry, the dashboard never selected the relation's project,
// and `/projects` is the public showcase (`isPublic: true` only), so a private
// project the mentee was assigned to appeared nowhere. Their own project was
// reachable only by typing its URL.
//
// This is deliberately NOT the showcase scope: it answers "mine", not
// "browsable". Membership has the same two sources mergeTeam() unions —
// a ProjectMember row (#617/#619) or a legacy MentorshipRelation.projectId —
// so both are queried here; reading only one of them is exactly the bug that
// made pre-#617 assignments invisible.
// ---------------------------------------------------------------------------

export interface MenteeProject {
  id: string;
  name: string;
  description: string | null;
  technologies: string[];
  status: string;
  isPublic: boolean;
  repoUrl: string | null;
  demoUrl: string | null;
  boardUrl: string | null;
  /** Display name of the owning company or person, when there is one. */
  owner: string | null;
  team: TeamMember[];
  internCount: number;
}

/** `where` matching every project this person is actually on (either source). */
export function menteeProjectWhere(userId: string) {
  return {
    OR: [
      { members: { some: { userId } } },
      { relations: { some: { menteeId: userId } } },
    ],
  };
}

/**
 * The projects this mentee belongs to, most recently updated first.
 * `take` caps the list for the dashboard card; omit it for the full page.
 */
export async function loadMenteeProjects(userId: string, take?: number): Promise<MenteeProject[]> {
  if (!userId) return [];

  const projects = await prisma.project.findMany({
    where: menteeProjectWhere(userId),
    orderBy: { updatedAt: 'desc' },
    ...(take ? { take } : {}),
    select: {
      id: true,
      name: true,
      description: true,
      technologies: true,
      status: true,
      isPublic: true,
      repoUrl: true,
      demoUrl: true,
      boardUrl: true,
      ownerType: true,
      ownerUser: { select: { fullName: true } },
      ownerCompany: { select: { name: true } },
      members: {
        orderBy: { addedAt: 'asc' },
        select: { role: true, functionalRole: true, addedAt: true, user: { select: { id: true, fullName: true } } },
      },
      // No `take` on the relations: the merged team drives the intern count, and
      // a truncated list would under-count it (same trap as /api/projects).
      relations: {
        where: { status: 'ACTIVE' },
        select: {
          mentee: { select: { id: true, fullName: true } },
          mentor: { select: { id: true, fullName: true } },
        },
      },
    },
  });

  return projects.map((p) => {
    const team = mergeTeam(p.members, p.relations);
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      technologies: Array.isArray(p.technologies) ? (p.technologies as string[]) : [],
      status: p.status,
      isPublic: p.isPublic,
      repoUrl: p.repoUrl,
      demoUrl: p.demoUrl,
      boardUrl: p.boardUrl,
      owner: p.ownerType === 'COMPANY' ? p.ownerCompany?.name ?? null : p.ownerUser?.fullName ?? null,
      team,
      internCount: internCount(team),
    };
  });
}
