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
 *
 * WHY A `total` IS RETURNED. The card's own copy promises that every visit is
 * recorded "permanently, and nobody can remove a line from this list". A
 * silent cut at the newest 50 would make that sentence false for anybody with
 * a longer history: they would see 50 and have no way to learn there were 60.
 * So the count of sessions is returned alongside the page, and the card says
 * how many it is showing whenever the two differ.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = session.user.id;
  const since = IMPERSONATION_HISTORY_RETENTION_DAYS
    ? new Date(Date.now() - IMPERSONATION_HISTORY_RETENTION_DAYS * 86_400_000)
    : undefined;

  const withinWindow = { ...(since ? { createdAt: { gte: since } } : {}) };

  // Exactly one session per START row (a stop never creates one, and an orphan
  // stop is dropped), so counting starts counts sessions.
  const total = await prisma.auditLog.count({
    where: { targetId: userId, action: IMPERSONATE_START, ...withinWindow },
  });

  // The page boundary is drawn on STARTS, not on rows. Taking the newest 2N+1
  // rows instead was off by up to a session: orphan stops sitting at the older
  // edge of the window each eat a row and yield nothing, so a full history
  // could answer with 49 sessions and no way to tell that from "there are 49".
  // Reading the Nth-newest start first and then every row at or after it makes
  // the count exact, at the cost of one more read of the same `targetId` index.
  const starts = await prisma.auditLog.findMany({
    where: { targetId: userId, action: IMPERSONATE_START, ...withinWindow },
    take: IMPERSONATION_HISTORY_LIMIT,
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  const floor = starts.length ? starts[starts.length - 1].createdAt : null;

  // Ascending, so start/stop rows pair in the order they happened. Every stop
  // that can close one of these starts is at or after the floor; a stop in
  // here whose start is older than the floor is an orphan and gets dropped.
  const rows = floor
    ? await prisma.auditLog.findMany({
        where: {
          targetId: userId,
          action: { in: [IMPERSONATE_START, IMPERSONATE_STOP] },
          createdAt: { gte: floor },
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true, actorId: true, action: true, detail: true, createdAt: true },
      })
    : [];

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
    // How many there are in total, so the card can admit when it is showing a
    // page rather than the whole record.
    total,
    // null = the record goes back to the beginning of the account. The card
    // needs this to tell "nobody ever did" apart from "nobody did recently".
    retentionDays: IMPERSONATION_HISTORY_RETENTION_DAYS,
  });
}
