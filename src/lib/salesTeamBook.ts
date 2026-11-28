// The team's sales book — READ-ONLY (src/lib/salesBookRule.ts, the user's
// decision of 2026-11-15). One loader for GET /api/sales/team-book, the board's
// "Team" view and /sales/team.
//
// What a row carries is a short, deliberate list: who the lead is, the account,
// the owner, the stage, how long it has sat there, when it was last in contact,
// and the trial end (the board's trial chips, #3813 — the lead page shows it to
// a colleague too).
// NOT the contact's e-mail or phone, the deal value or the follow-up
// (nextAction*): those stay the owner's (canSeeNextAction, the lead page). The
// select below is the guarantee — a field that is not selected cannot leak —
// and e2e/sales-team-book.spec.ts asserts the keys of the answer.
//
// Counts per stage and per owner are over the whole book (tenant + status), not
// the 500 rows, and ignore the owners/stage/handed-off filters, so a page's tabs and owner
// strip always show the whole team. Server-only.
import type { Session } from 'next-auth';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { salesTeamReadAllowed } from '@/lib/salesBook';
import { salesTeamReadWhere } from '@/lib/salesBookRule';
import { getLastContacts } from '@/lib/lastContact';
import { handedOnBy } from '@/lib/leadHandoffRule';

export const SALES_TEAM_BOOK_LIMIT = 500;
const DAY = 24 * 60 * 60 * 1000;

export type SalesTeamBookStatus = 'active' | 'all';

export interface SalesTeamBookQuery {
  owners?: string[];
  stage?: string;
  /** Default 'active'. */
  status?: SalesTeamBookStatus;
  /**
   * "Handed on by me" (#3980): only the records whose last hand-off took them
   * from the VIEWER or was done by the viewer, and that are not back with them
   * (`handedOnBy`). Always the session's own user — never a person named in
   * the query.
   */
  handedOff?: boolean;
}

export interface SalesTeamBookRow {
  /** The relation id — /sales/leads/<id>. */
  id: string;
  leadName: string;
  companyId: string | null;
  companyName: string | null;
  ownerId: string;
  ownerName: string;
  ownerAvatarUrl: string | null;
  /** Stage key. */
  pipelineStatus: string;
  status: 'ACTIVE' | 'COMPLETED';
  /** Whole days since the last move into the current stage (startDate when it never moved). */
  daysInStage: number;
  /** ISO; the src/lib/lastContact.ts rule. */
  lastContactAt: string | null;
  /** The trial end, ISO; null without one. */
  trialEndsAt: string | null;
}

export interface SalesTeamStageCount {
  stage: string;
  count: number;
}

export interface SalesTeamOwnerCount {
  ownerId: string;
  ownerName: string;
  ownerAvatarUrl: string | null;
  count: number;
}

export interface SalesTeamBook {
  /** At most SALES_TEAM_BOOK_LIMIT, newest startDate first. */
  rows: SalesTeamBookRow[];
  byStage: SalesTeamStageCount[];
  byOwner: SalesTeamOwnerCount[];
  /** The filtered total, not capped. */
  total: number;
  truncated: boolean;
}

/** A query string → the loader's query; anything unknown is dropped, never widened. */
export function parseSalesTeamBookQuery(params: URLSearchParams): SalesTeamBookQuery {
  const owners = (params.get('owners') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 64)
    .slice(0, 100);
  const stage = params.get('stage')?.trim();
  return {
    ...(owners.length ? { owners } : {}),
    ...(stage && stage.length <= 64 ? { stage } : {}),
    status: params.get('status') === 'all' ? 'all' : 'active',
    ...(params.get('handedOff') === '1' ? { handedOff: true } : {}),
  };
}

/** Upper bound on the hand-offs read for "handed on by me" — a rep's own history, not the org's. */
const HANDED_OFF_SCAN = 2000;

/**
 * The ids of the records `viewerId` handed on (#3980, `handedOnBy`): the
 * candidates are the hand-offs from or by them; each candidate is then judged
 * on its LAST hand-off, which may be someone else's. The tenant and the read
 * rule are applied by the caller's WHERE on the relations themselves.
 */
async function relationsHandedOnBy(viewerId: string, tenant: Awaited<ReturnType<typeof tenantWhere>>): Promise<string[]> {
  const candidates = await prisma.followUpEvent.findMany({
    where: { kind: 'HANDED_OFF', OR: [{ fromUserId: viewerId }, { actorId: viewerId }] },
    orderBy: { createdAt: 'desc' },
    take: HANDED_OFF_SCAN,
    select: { relationId: true },
  });
  const ids = [...new Set(candidates.map((c) => c.relationId))];
  if (!ids.length) return [];
  const [events, owners] = await Promise.all([
    prisma.followUpEvent.findMany({
      where: { kind: 'HANDED_OFF', relationId: { in: ids } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { relationId: true, fromUserId: true, actorId: true },
    }),
    prisma.mentorshipRelation.findMany({ where: withinTenant({ id: { in: ids } }, tenant), select: { id: true, mentorId: true } }),
  ]);
  const last = new Map<string, { fromUserId: string | null; actorId: string | null }>();
  for (const e of events) if (!last.has(e.relationId)) last.set(e.relationId, e);
  return owners.filter((r) => handedOnBy(last.get(r.id), r.mentorId, viewerId)).map((r) => r.id);
}

/** null = this session may not read the team book (the caller answers 404). */
export async function loadSalesTeamBook(session: Session, query: SalesTeamBookQuery = {}, now: Date = new Date()): Promise<SalesTeamBook | null> {
  const narrow = salesTeamReadWhere(await salesTeamReadAllowed(session));
  if (!narrow) return null;
  const tenant = await tenantWhere(session);

  const base: Prisma.MentorshipRelationWhereInput = withinTenant(
    { ...narrow, ...(query.status === 'all' ? {} : { status: 'ACTIVE' as const }) },
    tenant,
  );
  const handedOffIds = query.handedOff ? await relationsHandedOnBy(session.user.id, tenant) : null;
  const filtered: Prisma.MentorshipRelationWhereInput = {
    AND: [
      base,
      ...(handedOffIds ? [{ id: { in: handedOffIds } }] : []),
      ...(query.owners?.length ? [{ mentorId: { in: query.owners } }] : []),
      ...(query.stage ? [{ pipelineStatus: query.stage }] : []),
    ],
  };

  const [relations, total, stageGroups, ownerGroups] = await Promise.all([
    prisma.mentorshipRelation.findMany({
      where: filtered,
      orderBy: [{ startDate: 'desc' }, { id: 'asc' }],
      take: SALES_TEAM_BOOK_LIMIT,
      select: {
        id: true,
        menteeId: true,
        mentorId: true,
        pipelineStatus: true,
        status: true,
        startDate: true,
        trialEndsAt: true,
        mentee: { select: { fullName: true } },
        mentor: { select: { fullName: true, avatarUrl: true } },
        company: { select: { id: true, name: true } },
        statusChanges: { orderBy: { createdAt: 'desc' }, take: 5, select: { toStatus: true, createdAt: true } },
      },
    }),
    prisma.mentorshipRelation.count({ where: filtered }),
    prisma.mentorshipRelation.groupBy({ by: ['pipelineStatus'], where: base, _count: { _all: true } }),
    prisma.mentorshipRelation.groupBy({ by: ['mentorId'], where: base, _count: { _all: true } }),
  ]);

  const ownerIds = ownerGroups.map((g) => g.mentorId);
  const [owners, lastContacts] = await Promise.all([
    prisma.user.findMany({
      where: withinTenant({ id: { in: ownerIds } }, tenant),
      select: { id: true, fullName: true, avatarUrl: true },
    }),
    getLastContacts(relations.map((r) => ({ id: r.id, menteeId: r.menteeId }))),
  ]);
  const ownerById = new Map(owners.map((o) => [o.id, o]));

  const rows: SalesTeamBookRow[] = relations.map((r) => {
    const entered = r.statusChanges.find((c) => c.toStatus === r.pipelineStatus)?.createdAt ?? r.startDate;
    return {
      id: r.id,
      leadName: r.mentee.fullName,
      companyId: r.company?.id ?? null,
      companyName: r.company?.name ?? null,
      ownerId: r.mentorId,
      ownerName: r.mentor.fullName,
      ownerAvatarUrl: r.mentor.avatarUrl ?? null,
      pipelineStatus: r.pipelineStatus,
      status: r.status,
      daysInStage: Math.max(0, Math.floor((now.getTime() - entered.getTime()) / DAY)),
      lastContactAt: lastContacts.get(r.id)?.at.toISOString() ?? null,
      trialEndsAt: r.trialEndsAt?.toISOString() ?? null,
    };
  });

  return {
    rows,
    byStage: stageGroups
      .map((g) => ({ stage: g.pipelineStatus, count: g._count._all }))
      .sort((a, b) => b.count - a.count || a.stage.localeCompare(b.stage)),
    byOwner: ownerGroups
      .map((g) => {
        const o = ownerById.get(g.mentorId);
        return { ownerId: g.mentorId, ownerName: o?.fullName ?? '', ownerAvatarUrl: o?.avatarUrl ?? null, count: g._count._all };
      })
      .sort((a, b) => b.count - a.count || a.ownerName.localeCompare(b.ownerName)),
    total,
    truncated: total > rows.length,
  };
}
