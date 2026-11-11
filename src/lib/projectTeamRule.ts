// Who may manage a project's team, and whom they may put on it (#2272).
//
// Pure and dependency-free (unit-tested in e2e/project-team-rule.unit.spec.ts):
// the routes load the facts — the project's owner pointer and member rows, the
// target user, the actor's connections — and ask this module. No route filters
// candidates by hand; the picker (`GET /api/projects/[id]/members/candidates`)
// and the write (`POST /api/projects/[id]/members`) both call `addableSeats()`,
// so the list a person is offered is exactly the set the write accepts.
//
// The addable set, per actor:
//   ADMIN  — any active user of the tenant (the loader scopes it).
//   MENTOR — any active mentor/admin of the tenant (as OWNER/MENTOR), and the
//            mentees they mentor (as MENTEE) — the rule this route had before.
//   MENTEE — only the people the mentee is already connected to through an
//            ACTIVE mentorship: their own mentor(s) (as OWNER/MENTOR) and the
//            other mentees of those mentors (as MENTEE). #2270 refused every
//            direct add by a mentee because the old check was role-blind and
//            would have let them seat any mentee of the tenant.
// Everyone else (COMPANY, SOURCE, …) adds nobody.
//
// Anything outside the set answers like a missing user (404): a refusal that
// differs from "no such person" would confirm the id belongs to someone.
//
// A mentee's circle is read from SEATS (#3584): the primary pair of every
// relation and the extra seats of a group relation (#1804, RelationParticipant).
// Which seat counts is `menteeConnectionsFromSeats()` below — only an active
// seat, in an ACTIVE relation, of an active, un-benched person, with both the
// relation and the person in the caller's own org.

export type TeamSeat = 'OWNER' | 'MENTOR' | 'MENTEE';

export interface TeamActor {
  id: string;
  role: string;
}

export interface TeamProject {
  ownerUserId: string | null;
  members: { userId: string; role: string }[];
}

export interface TeamTarget {
  id: string;
  role: string;
  isActive: boolean;
}

/**
 * The actor's connections, as the loader read them.
 * MENTOR actor: `mentees` = the mentees they mentor; `mentors` is unused.
 * MENTEE actor: `mentors` = their ACTIVE mentors; `mentees` = the other mentees
 * of those mentors (ACTIVE relations), never the actor themselves.
 */
export interface TeamConnections {
  mentors: ReadonlySet<string>;
  mentees: ReadonlySet<string>;
}

export const NO_CONNECTIONS: TeamConnections = { mentors: new Set(), mentees: new Set() };

/**
 * One person's place in one relation, as the loader read it: the primary pair
 * (from the relation's `mentorId`/`menteeId`, never left) or a group seat
 * beyond it. `side` is MENTOR for a mentor or facilitator seat.
 */
export interface RelationSeat {
  relationId: string;
  relationStatus: string;
  relationOrgId: string | null;
  userId: string;
  userOrgId: string | null;
  userActive: boolean;
  userState: string | null;
  side: 'MENTOR' | 'MENTEE';
  leftAt: Date | null;
}

/** The caller's org. NULL on any side is the default org's, never a wildcard. */
export interface TeamOrg {
  orgId: string | null;
  defaultOrgId: string;
}

function sameOrg(rowOrgId: string | null, org: TeamOrg): boolean {
  return (rowOrgId || org.defaultOrgId) === (org.orgId || org.defaultOrgId);
}

/**
 * Does this seat count at all? Only active participation (#3584): the seat was
 * not left, the relation is ACTIVE (not completed or ended), the person is an
 * active account that is not on the bench, and both the relation and the
 * person belong to the caller's org — checked here, not left to the query.
 */
export function seatCounts(seat: RelationSeat, org: TeamOrg): boolean {
  return (
    seat.relationStatus === 'ACTIVE' &&
    seat.leftAt === null &&
    seat.userActive &&
    seat.userState !== 'BENCHED' &&
    sameOrg(seat.relationOrgId, org) &&
    sameOrg(seat.userOrgId, org)
  );
}

/**
 * A MENTEE's circle from seats. Their own relations are those where they hold
 * a counting MENTEE seat; the mentors are the counting mentor seats there; the
 * peers are the counting mentee seats of every relation one of those mentors
 * leads (their own included) — "my mentor's other mentees", now group-aware.
 */
export function menteeConnectionsFromSeats(actorId: string, seats: readonly RelationSeat[], org: TeamOrg): TeamConnections {
  const counting = seats.filter((s) => seatCounts(s, org));
  const own = new Set(counting.filter((s) => s.userId === actorId && s.side === 'MENTEE').map((s) => s.relationId));
  if (own.size === 0) return { mentors: new Set(), mentees: new Set() };
  const mentors = new Set(
    counting.filter((s) => own.has(s.relationId) && s.side === 'MENTOR' && s.userId !== actorId).map((s) => s.userId)
  );
  const led = new Set(counting.filter((s) => s.side === 'MENTOR' && mentors.has(s.userId)).map((s) => s.relationId));
  for (const id of own) led.add(id);
  const mentees = new Set(
    counting.filter((s) => led.has(s.relationId) && s.side === 'MENTEE' && s.userId !== actorId).map((s) => s.userId)
  );
  return { mentors, mentees };
}

/**
 * Who may read the roster and change it: an admin, an OWNER member, or the
 * legacy `ownerUserId` pointer (a project whose OWNER row was never backfilled
 * still has a real owner — /projects/[id] derives `isLead` from that pointer).
 */
export function canManageProjectTeam(actor: TeamActor, project: TeamProject): boolean {
  if (actor.role === 'ADMIN') return true;
  if (project.ownerUserId && project.ownerUserId === actor.id) return true;
  return project.members.some((m) => m.userId === actor.id && m.role === 'OWNER');
}

/** The seats a person can structurally hold: mentees contribute, mentors/admins lead. */
function structuralSeats(targetRole: string): TeamSeat[] {
  if (targetRole === 'MENTEE') return ['MENTEE'];
  if (targetRole === 'MENTOR' || targetRole === 'ADMIN') return ['OWNER', 'MENTOR'];
  return [];
}

/**
 * The seats `actor` may give `target` on a project they manage — empty when
 * the target is not theirs to add. Ownership of the project is NOT checked
 * here; ask `canManageProjectTeam()` first.
 */
export function addableSeats(actor: TeamActor, target: TeamTarget | null, connections: TeamConnections): TeamSeat[] {
  if (!target || !target.isActive) return [];
  const seats = structuralSeats(target.role);
  if (seats.length === 0) return [];
  switch (actor.role) {
    case 'ADMIN':
      return seats;
    case 'MENTOR':
      if (target.role === 'MENTEE') return connections.mentees.has(target.id) ? seats : [];
      return seats;
    case 'MENTEE':
      if (target.id === actor.id) return [];
      if (target.role === 'MENTEE') return connections.mentees.has(target.id) ? seats : [];
      return connections.mentors.has(target.id) ? seats : [];
    default:
      return [];
  }
}

export type MemberAddRefusal =
  | { status: 404; code: 'not_addable' }
  | { status: 400; code: 'wrong_seat' };

/**
 * The write's decision. A target outside the actor's set is a 404 — the same
 * answer as an id that matches nobody. A target inside it asked for a seat they
 * cannot hold (a mentee as OWNER) is a 400: the actor already knows the person.
 */
export function memberAddRefusal(
  actor: TeamActor,
  target: TeamTarget | null,
  seat: TeamSeat,
  connections: TeamConnections
): MemberAddRefusal | null {
  const seats = addableSeats(actor, target, connections);
  if (seats.length === 0) return { status: 404, code: 'not_addable' };
  if (!seats.includes(seat)) return { status: 400, code: 'wrong_seat' };
  return null;
}

/**
 * Who may create, move or cancel a project's recurring meeting: anyone who
 * manages the team, plus a MENTOR member (the collaborative field set mentors
 * have always had). A MENTEE writes it only as the project's owner — a plain
 * mentee member reads the series, never changes it.
 */
export function canWriteProjectSeries(actor: TeamActor, project: TeamProject): boolean {
  if (canManageProjectTeam(actor, project)) return true;
  if (actor.role !== 'MENTOR') return false;
  return project.members.some((m) => m.userId === actor.id);
}

/**
 * How a caller who does not manage the team is refused: a member knows the
 * project exists, so theirs is the honest 403; anyone else gets the 404 a
 * missing project gets (#2542), never a 403 that confirms the id.
 */
export function nonManagerStatus(actorId: string, project: TeamProject): 403 | 404 {
  return project.members.some((m) => m.userId === actorId) ? 403 : 404;
}
