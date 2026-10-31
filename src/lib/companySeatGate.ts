// Team seats at a company (#1870, docs/company-team-seats.md) — the server
// half: resolve a COMPANY user's seat role and gate a route on it. The rule is
// pure in src/lib/companySeats.ts. Server-only.
//
// ONE helper, requireCompanySeat(), is how a company-side route asks "may this
// seat do that" — a hidden button is never the check. Admins and every
// non-COMPANY role pass straight through: their own permission system
// (src/lib/authz.ts) already decided, and seats are a refinement INSIDE a
// company, not a second permission system next to it.

import { NextResponse } from 'next/server';
import type { Session } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { companyCan, IMPLICIT_SEAT_ROLE, INSUFFICIENT_SEAT_ROLE, isSeatRole, type CompanyAction, type SeatRole } from '@/lib/companySeats';
import type { ApplicationActor } from '@/lib/applicationStage';

/** The seat role of a COMPANY user at its company: its membership's, or OWNER for the implicit first login. */
export async function seatRoleOf(userId: string, companyId: string): Promise<SeatRole> {
  const row = await prisma.companyMembership.findUnique({
    where: { companyId_userId: { companyId, userId } },
    select: { seatRole: true },
  });
  if (!row) return IMPLICIT_SEAT_ROLE;
  // An unknown stored value reads as the weakest seat, never the strongest.
  return isSeatRole(row.seatRole) ? row.seatRole : 'INTERVIEWER';
}

/** null when the caller may go on; a 403 `insufficient_seat_role` otherwise. */
export async function requireCompanySeat(session: Session, action: CompanyAction): Promise<NextResponse | null> {
  if (session.user.role !== 'COMPANY') return null;
  const companyId = session.user.companyId;
  // No company at all is the routes' own `company_not_assigned`, answered before this.
  if (!companyId) return null;
  const seatRole = await seatRoleOf(session.user.id, companyId);
  if (companyCan(seatRole, action)) return null;
  return NextResponse.json({ error: 'Your seat at this company does not allow this', code: INSUFFICIENT_SEAT_ROLE, action, seatRole }, { status: 403 });
}

/**
 * The application actor with an INTERVIEWER seat narrowed to the candidates of
 * the panels it sits on (`visibleApplicationsWhere()` applies it in the WHERE,
 * so counts and pages stay right). Every other actor is returned unchanged.
 */
export async function seatScopedActor(actor: ApplicationActor): Promise<ApplicationActor> {
  if (actor.role !== 'COMPANY' || !actor.companyId) return actor;
  if ((await seatRoleOf(actor.id, actor.companyId)) !== 'INTERVIEWER') return actor;
  const panels = await prisma.interviewPanel.findMany({
    where: { orgId: actor.orgId, members: { some: { userId: actor.id } } },
    select: { subjectId: true },
  });
  return { ...actor, interviewerMenteeIds: [...new Set(panels.map((p) => p.subjectId))] };
}
