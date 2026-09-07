import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
  IMPERSONATE_START,
  IMPERSONATE_STOP,
  IMPERSONATION_HISTORY_LIMIT,
  IMPERSONATION_HISTORY_RETENTION_DAYS,
  pairImpersonationSessions,
} from '@/lib/impersonationHistory';

/**
 * GET — "who accessed my account": every impersonated session on the
 * signed-in user's own account, newest first (#1587).
 *
 * WHOSE ROWS. `session.user.id`, always. There is no `userId` parameter and no
 * filter of any kind, because there is no legitimate second answer: this
 * endpoint exists so a person can read their own record. A parameter here would
 * be an IDOR onto "which admin visited which user", which is precisely the data
 * that must not leak sideways. Every read goes through an explicit `select`
 * allowlist for the same reason.
 *
 * WHAT THE VIEWER LEARNS ABOUT THE ADMIN — a judgement call, decided here:
 * the admin's DISPLAY NAME, and nothing else. Not their e-mail, not their id,
 * not their role or avatar. Entering someone else's account is an act performed
 * in an official capacity, and accountability without a name is not
 * accountability — "an administrator" gives the user nobody to ask about. The
 * name is what a support conversation needs; an e-mail address additionally
 * hands out a staff member's direct contact and a login identifier to anybody
 * who ever filed a ticket, which buys the user nothing they cannot get by
 * asking. When the admin's account is gone the name is simply absent, and the
 * card says so rather than substituting an id.
 *
 * The rows themselves are read-only here and nowhere else offers a delete: an
 * access record the accessing party can erase is worth nothing.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = session.user.id;
  const since = IMPERSONATION_HISTORY_RETENTION_DAYS
    ? new Date(Date.now() - IMPERSONATION_HISTORY_RETENTION_DAYS * 86_400_000)
    : undefined;

  // Ascending, so start/stop rows pair in the order they happened. The cap is
  // on rows rather than sessions and is read from the newest end — taking the
  // OLDEST 2N rows would show a user their first ever visits and hide today's.
  const newest = await prisma.auditLog.findMany({
    where: {
      targetId: userId,
      action: { in: [IMPERSONATE_START, IMPERSONATE_STOP] },
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    // Two rows per session, plus one for a stop whose start is off the edge.
    take: IMPERSONATION_HISTORY_LIMIT * 2 + 1,
    orderBy: { createdAt: 'desc' },
    select: { id: true, actorId: true, action: true, detail: true, createdAt: true },
  });
  const rows = newest.reverse();

  const actorIds = [...new Set(rows.map((r) => r.actorId))];
  const admins = actorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, fullName: true },
      })
    : [];
  const names = new Map(admins.map((a) => [a.id, a.fullName]));

  const sessions = pairImpersonationSessions(rows, names).slice(0, IMPERSONATION_HISTORY_LIMIT);

  return NextResponse.json({
    sessions,
    // null = the record goes back to the beginning of the account. The card
    // needs this to tell "nobody ever did" apart from "nobody did recently".
    retentionDays: IMPERSONATION_HISTORY_RETENTION_DAYS,
  });
}
