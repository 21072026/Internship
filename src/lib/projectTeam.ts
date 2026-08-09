import { prisma } from '@/lib/prisma';

// ---------------------------------------------------------------------------
// One canonical answer to "who is on this project?" (#51).
//
// Two tables can say someone belongs to a project:
//   1. ProjectMember   — the current, person-level membership table (#617/#619),
//                        with a structural role (OWNER/MENTOR/MENTEE) and, for
//                        mentees, a functional role (developer/tester/…).
//   2. MentorshipRelation.projectId — the original way a mentee was attached to
//                        a project, still carried by every pre-#617 row.
//
// The cards used to count and name people from (2) alone, which is why a project
// whose members were all added through the member panel still advertised "2
// interns" with two unrelated names: the legacy relations were the only thing
// being read. Everything now goes through mergeTeam(), which unions both sources
// and lets the ProjectMember row win when a person appears in each.
// ---------------------------------------------------------------------------

export type StructuralRole = 'OWNER' | 'MENTOR' | 'MENTEE';
export type FunctionalRole = 'DEVELOPER' | 'TESTER' | 'MARKETING';

export interface TeamMember {
  id: string;
  fullName: string;
  role: StructuralRole;
  functionalRole: FunctionalRole | null;
  addedAt: string | null;
  /** True when this person is only known through a legacy MentorshipRelation. */
  legacy: boolean;
  /**
   * The member's saved IANA zone, or null when they have none (#1210). Carried
   * on the team so a recurring project call can be shown on every member's
   * clock before it is agreed, not only after the reminder lands.
   */
  timezone: string | null;
}

interface MemberRow {
  role: StructuralRole;
  functionalRole?: FunctionalRole | null;
  addedAt?: Date | string | null;
  user: { id: string; fullName: string; timezone?: string | null };
}

interface RelationRow {
  mentee?: { id: string; fullName: string; timezone?: string | null } | null;
  mentor?: { id: string; fullName: string; timezone?: string | null } | null;
}

const ROLE_ORDER: Record<StructuralRole, number> = { OWNER: 0, MENTOR: 1, MENTEE: 2 };

const iso = (v: Date | string | null | undefined) =>
  v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null;

/**
 * The project's team, newest source of truth first. `members` rows win over
 * anything derived from `relations`, so a mentee added through the member panel
 * keeps the functional role that was chosen there.
 */
export function mergeTeam(members: MemberRow[] = [], relations: RelationRow[] = []): TeamMember[] {
  const byId = new Map<string, TeamMember>();

  for (const m of members) {
    if (!m?.user?.id) continue;
    byId.set(m.user.id, {
      id: m.user.id,
      fullName: m.user.fullName,
      role: m.role,
      functionalRole: m.role === 'MENTEE' ? m.functionalRole ?? null : null,
      addedAt: iso(m.addedAt),
      legacy: false,
      timezone: m.user.timezone ?? null,
    });
  }

  for (const r of relations) {
    for (const [person, role] of [
      [r.mentee, 'MENTEE'],
      [r.mentor, 'MENTOR'],
    ] as const) {
      if (!person?.id || byId.has(person.id)) continue;
      byId.set(person.id, {
        id: person.id,
        fullName: person.fullName,
        role,
        functionalRole: null,
        addedAt: null,
        legacy: true,
        timezone: person.timezone ?? null,
      });
    }
  }

  return [...byId.values()].sort(
    (a, b) =>
      ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
      (a.addedAt ?? '').localeCompare(b.addedAt ?? '') ||
      a.fullName.localeCompare(b.fullName)
  );
}

/** How many mentees (interns) are on the project — the "N stajyer" figure. */
export function internCount(team: TeamMember[]): number {
  return team.filter((m) => m.role === 'MENTEE').length;
}

/** Load and merge the team straight from the database. */
export async function loadProjectTeam(projectId: string): Promise<TeamMember[]> {
  if (!projectId) return [];
  const [members, relations] = await Promise.all([
    prisma.projectMember.findMany({
      where: { projectId },
      orderBy: { addedAt: 'asc' },
      select: { role: true, functionalRole: true, addedAt: true, user: { select: { id: true, fullName: true, timezone: true } } },
    }),
    prisma.mentorshipRelation.findMany({
      where: { projectId, status: 'ACTIVE' },
      select: {
        mentee: { select: { id: true, fullName: true, timezone: true } },
        mentor: { select: { id: true, fullName: true, timezone: true } },
      },
    }),
  ]);
  return mergeTeam(members, relations);
}
