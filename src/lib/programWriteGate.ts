// The ONE gate for reaching a programme (Cohort) by id (#3576, #3582). Server-only.
//
// `requirePermission('program.write')` with no subject only checks the tier, so
// a route that then wrote `prisma.cohort.update({ where: { id } })` let an
// admin of one org rename or delete another org's programme (the tenant
// middleware is a passthrough while MT_ENFORCE_ISOLATION is off). This gate:
//
//   1. loads the programme INSIDE the caller's tenant (`tenantWhere`, so the
//      default org still matches its legacy NULL-org rows);
//   2. asks `program.write` with the programme as the subject — an org admin of
//      that org passes, a PROGRAM_ADMIN only with a grant for it;
//   3. answers 404 for a programme the caller may not touch: another org's (it
//      does not exist in this tenant) and, for a PROGRAM_ADMIN, one outside its
//      grants — a 403 there would confirm the id. The refusal is still written
//      by requirePermission (`authz.capability_denied`). A caller whose tier
//      never holds the permission keeps the plain 403 it always got.

import { NextResponse } from 'next/server';
import type { Session } from 'next-auth';
import { actorFromSession, requirePermission, type Actor, type Permission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';

export interface WritableProgram {
  id: string;
  orgId: string | null;
  name: string;
  term: string | null;
  eligibilityMode: string;
}

export type ProgramPermission = Extract<Permission, 'program.read' | 'program.write'>;

const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404 });

/**
 * `session` is the route's own `getServerSession(authOptions)` — read there so
 * the route visibly authenticates its caller (check:route-auth).
 */
export function programWriteGate(request: Request, session: Session | null, programId: string) {
  return programGate(request, session, programId, 'program.write');
}

export async function programGate(
  request: Request,
  session: Session | null,
  programId: string,
  permission: ProgramPermission,
): Promise<{ session: Session; actor: Actor; program: WritableProgram } | { error: NextResponse }> {
  const live = await actorFromSession(session);
  const program = session
    ? await prisma.cohort.findFirst({
        where: withinTenant({ id: programId }, await tenantWhere(session)),
        select: { id: true, orgId: true, name: true, term: true, eligibilityMode: true },
      })
    : null;
  const gate = await requirePermission(permission, {
    request,
    subject: { orgId: program?.orgId ?? live?.orgId ?? null, cohortId: programId },
  });
  if ('error' in gate) {
    const outOfScope = live?.adminLevel === 'PROGRAM_ADMIN' && !live.impersonatorId && gate.error.status === 403;
    return { error: outOfScope ? notFound() : gate.error };
  }
  if (!program) return { error: notFound() };
  return { session: gate.session, actor: gate.actor, program };
}
