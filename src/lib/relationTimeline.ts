// One chronological record of a mentorship pairing (#1702, story #1687).
//
// A relationship's history is scattered across six tables. This module is the
// ONE place that merges them: the API route hands it a relation id and a
// viewer, gets back a single newest-first page of typed rows. The merge is
// deliberately server-side — four client fetches interleaved in a component
// would make the ordering a client concern and multiply the round trips, and
// the per-role redaction below could then only be advisory.
//
// ── Dates: which column is the event ────────────────────────────────────────
// Every source is queried on the column that says WHEN THE THING HAPPENED, not
// when the row was written. They differ, and picking wrong dates a meeting
// scheduled for next week to the day someone typed it in:
//   StatusChange    createdAt   — the move is the write
//   InteractionLog  date        — the mentor states when the contact happened
//   Meeting         scheduledAt when it has one, else createdAt (a link-only
//                               meeting has no time, so the row's birth is all
//                               there is)
//   Goal            completedAt when done, else createdAt
//   WeeklyReport    createdAt   — no submittedAt column exists
//   Offer           decidedAt ?? sentAt ?? createdAt — the latest thing that
//                               actually happened to it
//   RelationNote    createdAt
// SQL cannot ORDER BY a coalesce of two columns through Prisma, so each of
// those "?? " pairs is split into DISJOINT queries (one per branch) rather than
// sorted in JS after an unbounded read. Disjoint matters twice over: it keeps
// the page bounded, and it guarantees one row never emits two entries — which
// is what makes the cursor below a total order.

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { isStageTransition } from '@/lib/stageChange';
import { SUBMITTED_WEEKLY_REPORT_STATUSES } from '@/lib/weeklyReports';

export const TIMELINE_KINDS = ['stage', 'interaction', 'meeting', 'goal', 'report', 'offer', 'note'] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export function isTimelineKind(value: string): value is TimelineKind {
  return (TIMELINE_KINDS as readonly string[]).includes(value);
}

// Who the viewer is *to this relation*. Anything else has no timeline at all.
export type TimelineViewerRole = 'ADMIN' | 'MENTOR' | 'MENTEE';

// ── Per-role visibility ─────────────────────────────────────────────────────
// A mentee's view of their own pairing and an admin's view of it are not the
// same list. The rule mirrors what each role can already reach elsewhere in the
// app, so the timeline never becomes a side door around an existing boundary:
//   stage/interaction/goal — /portal/journey, /portal/interactions and
//                            /portal/goals already show the mentee these.
//   meeting                — the mentee is the invitee.
//   report                 — the mentee writes them (only submitted ones show;
//                            a DRAFT is not something that happened yet).
//   offer                  — visible, but never a DRAFT: that is an admin
//                            staging state (same rule as /api/offers).
//   note                   — RelationNote is the mentor's private note on the
//                            mentee. Never exposed to them (same rule as
//                            /api/relation-notes).
const MENTEE_KINDS: readonly TimelineKind[] = ['stage', 'interaction', 'meeting', 'goal', 'report', 'offer'];

export function visibleKinds(role: TimelineViewerRole): TimelineKind[] {
  return role === 'MENTEE' ? [...MENTEE_KINDS] : [...TIMELINE_KINDS];
}

export interface TimelineEntry {
  /** Stable, unique across kinds — the React key and the e2e handle. */
  id: string;
  kind: TimelineKind;
  /** The specific thing that happened; the client maps it to a label. */
  event: string;
  /** ISO instant the event happened (see the date table above). */
  at: string;
  /** Display name of whoever did it, when the row records one. */
  actor: string | null;
  /** Role that acted, when the row records that instead of a person. */
  actorRole: string | null;
  /** Free text from the row: meeting title, goal title, offer position, … */
  title: string | null;
  /** Secondary free text, already truncated for display. */
  detail: string | null;
  /** Stage keys — the client resolves labels through the tenant's stages. */
  fromStage?: string | null;
  toStage?: string | null;
  /** Row status (offer/goal/report), rendered as a badge. */
  status?: string | null;
  /**
   * Report rows only: ISO instant of the Monday the week starts on. Shipped as
   * an instant rather than a pre-formatted "2026-09-01" so the client can write
   * it in the viewer's locale, like every other date on the row.
   */
  weekStart?: string | null;
  /** Optional link to the underlying object. */
  href?: string | null;
  /** True when the system wrote the row rather than a person. */
  automatic?: boolean;
}

export interface TimelinePage {
  entries: TimelineEntry[];
  /** Opaque; pass back as `?cursor=` for the next page. Null = end of history. */
  nextCursor: string | null;
  /** Which kinds this viewer may ever see — drives the filter chips. */
  kinds: TimelineKind[];
}

export const DEFAULT_TIMELINE_LIMIT = 20;
export const MAX_TIMELINE_LIMIT = 50;
const DETAIL_CHARS = 240;

// ── Cursor ──────────────────────────────────────────────────────────────────
// "<epoch ms>_<row id>". The page is a total order on (at DESC, row id DESC):
// ids are cuids and unique across every table here, so the tiebreak is
// arbitrary but stable, and each source can express "strictly after the
// cursor" in SQL without knowing which table the cursor came from.
interface Cursor { ms: number; id: string }

export function parseCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null;
  const sep = raw.indexOf('_');
  if (sep <= 0) return null;
  const ms = Number(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (!Number.isFinite(ms) || !id) return null;
  return { ms, id };
}

function formatCursor(entry: { at: string; sortId: string }): string {
  return `${new Date(entry.at).getTime()}_${entry.sortId}`;
}

type WhereClause = Record<string, unknown>;

// "Strictly older than the cursor in (field DESC, id DESC) order."
function afterCursor(field: string, cursor: Cursor | null): WhereClause {
  if (!cursor) return {};
  const at = new Date(cursor.ms);
  return { OR: [{ [field]: { lt: at } }, { AND: [{ [field]: at }, { id: { lt: cursor.id } }] }] };
}

// Compose the clauses into one `where`. The cursor clause names its date column
// at runtime (each source has a different one), so the composed object is typed
// only at the call boundary — hence the single cast in `where<T>()`. Everything
// that decides *which* rows are returned is still written literally above.
function where<T>(...clauses: WhereClause[]): T {
  const parts = clauses.filter((c) => Object.keys(c).length > 0);
  return (parts.length <= 1 ? (parts[0] ?? {}) : { AND: parts }) as T;
}

function trim(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = value.trim();
  if (!text) return null;
  return text.length > DETAIL_CHARS ? `${text.slice(0, DETAIL_CHARS)}…` : text;
}

// An entry plus the raw row id the cursor compares against. `sortId` is the
// DB primary key; `id` is namespaced so two kinds can never collide as keys.
type Row = TimelineEntry & { sortId: string };

function row(kind: TimelineKind, event: string, sortId: string, at: Date, rest: Partial<TimelineEntry>): Row {
  return {
    id: `${kind}:${event}:${sortId}`,
    kind,
    event,
    at: at.toISOString(),
    actor: null,
    actorRole: null,
    title: null,
    detail: null,
    ...rest,
    sortId,
  };
}

export interface TimelineRequest {
  relationId: string;
  role: TimelineViewerRole;
  /** Narrow to these kinds; empty/absent means "every kind the role may see". */
  kinds?: readonly string[];
  limit?: number;
  cursor?: string | null;
}

export async function buildRelationTimeline(req: TimelineRequest): Promise<TimelinePage> {
  const { relationId, role } = req;
  const allowed = visibleKinds(role);
  const requested = (req.kinds ?? []).filter(isTimelineKind);
  const kinds = new Set<TimelineKind>(requested.length ? requested.filter((k) => allowed.includes(k)) : allowed);

  const limit = Math.min(MAX_TIMELINE_LIMIT, Math.max(1, req.limit ?? DEFAULT_TIMELINE_LIMIT));
  const cursor = parseCursor(req.cursor);
  // One extra row per source is what makes `hasMore` exact: every source's
  // WHERE already excludes everything the previous pages served, so the merged
  // list overflowing the page size is the only way more can exist.
  const take = limit + 1;
  const base = { relationId };
  const want = (kind: TimelineKind) => kinds.has(kind);

  const [
    statusChanges,
    interactions,
    timedMeetings,
    untimedMeetings,
    openGoals,
    doneGoals,
    reports,
    decidedOffers,
    sentOffers,
    draftOffers,
    notes,
  ] = await Promise.all([
    want('stage')
      ? prisma.statusChange.findMany({
          where: where<Prisma.StatusChangeWhereInput>(base, afterCursor('createdAt', cursor)),
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
          include: { changedBy: { select: { fullName: true } } },
        })
      : [],
    want('interaction')
      ? prisma.interactionLog.findMany({
          // An auto-logged row and its Meeting are literally the same event at
          // the same instant (lib/meetingAutoLog.ts dates the log at
          // scheduledAt). The log wins — a mentor may have edited its notes
          // into a real record — and the meeting query below drops the row
          // that has one, so the pair renders once.
          where: where<Prisma.InteractionLogWhereInput>(base, afterCursor('date', cursor)),
          orderBy: [{ date: 'desc' }, { id: 'desc' }],
          take,
        })
      : [],
    want('meeting')
      ? prisma.meeting.findMany({
          where: where<Prisma.MeetingWhereInput>(base, { scheduledAt: { not: null }, interaction: null }, afterCursor('scheduledAt', cursor)),
          orderBy: [{ scheduledAt: 'desc' }, { id: 'desc' }],
          take,
        })
      : [],
    want('meeting')
      ? prisma.meeting.findMany({
          where: where<Prisma.MeetingWhereInput>(base, { scheduledAt: null, interaction: null }, afterCursor('createdAt', cursor)),
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
        })
      : [],
    want('goal')
      ? prisma.goal.findMany({
          where: where<Prisma.GoalWhereInput>(base, { completedAt: null }, afterCursor('createdAt', cursor)),
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
        })
      : [],
    want('goal')
      ? prisma.goal.findMany({
          where: where<Prisma.GoalWhereInput>(base, { completedAt: { not: null } }, afterCursor('completedAt', cursor)),
          orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
          take,
        })
      : [],
    want('report')
      ? prisma.weeklyReport.findMany({
          where: where<Prisma.WeeklyReportWhereInput>(base, { status: { in: [...SUBMITTED_WEEKLY_REPORT_STATUSES] } }, afterCursor('createdAt', cursor)),
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
        })
      : [],
    want('offer')
      ? prisma.offer.findMany({
          where: where<Prisma.OfferWhereInput>(base, offerVisibility(role), { decidedAt: { not: null } }, afterCursor('decidedAt', cursor)),
          orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
          take,
          include: { decidedBy: { select: { fullName: true } }, company: { select: { name: true } } },
        })
      : [],
    want('offer')
      ? prisma.offer.findMany({
          where: where<Prisma.OfferWhereInput>(base, offerVisibility(role), { decidedAt: null, sentAt: { not: null } }, afterCursor('sentAt', cursor)),
          orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
          take,
          include: { createdBy: { select: { fullName: true } }, company: { select: { name: true } } },
        })
      : [],
    want('offer')
      ? prisma.offer.findMany({
          where: where<Prisma.OfferWhereInput>(base, offerVisibility(role), { decidedAt: null, sentAt: null }, afterCursor('createdAt', cursor)),
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
          include: { createdBy: { select: { fullName: true } }, company: { select: { name: true } } },
        })
      : [],
    want('note')
      ? prisma.relationNote.findMany({
          where: where<Prisma.RelationNoteWhereInput>(base, afterCursor('createdAt', cursor)),
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
          include: { author: { select: { fullName: true } } },
        })
      : [],
  ]);

  // Meeting records only `createdById` (no relation field on the model), and
  // WeeklyReport names its reviewer but not its author — resolve both in one
  // lookup rather than N.
  const organizerIds = [...timedMeetings, ...untimedMeetings].map((m) => m.createdById);
  const organizers = organizerIds.length
    ? await prisma.user.findMany({ where: { id: { in: [...new Set(organizerIds)] } }, select: { id: true, fullName: true } })
    : [];
  const nameById = new Map(organizers.map((u) => [u.id, u.fullName]));

  const merged: Row[] = [
    // A "correcting" history entry the admin typed by hand can have
    // from === to; isStageTransition() is what the relation detail API already
    // filters those out with, so the timeline agrees with it.
    ...statusChanges
      .filter((sc) => isStageTransition(sc.fromStatus, sc.toStatus))
      .map((sc) =>
        row('stage', 'stage_change', sc.id, sc.createdAt, {
          actor: sc.changedBy?.fullName ?? null,
          fromStage: sc.fromStatus,
          toStage: sc.toStatus,
          // The drop-off reason is an internal assessment of the candidate,
          // not something to read back to them.
          detail: role === 'MENTEE' ? null : trim(sc.reasonNote),
          status: role === 'MENTEE' ? null : sc.reasonCode,
        })
      ),
    ...interactions.map((i) =>
      row('interaction', 'interaction_logged', i.id, i.date, {
        title: trim(i.subject),
        detail: trim(i.notes),
        status: i.type,
        automatic: i.autoLogged,
      })
    ),
    ...timedMeetings.map((m) =>
      row('meeting', m.endedAt ? 'meeting_held' : 'meeting_scheduled', m.id, m.scheduledAt as Date, {
        title: trim(m.title),
        actor: nameById.get(m.createdById) ?? null,
        href: m.meetLink ?? null,
      })
    ),
    ...untimedMeetings.map((m) =>
      row('meeting', 'meeting_room', m.id, m.createdAt, {
        title: trim(m.title),
        actor: nameById.get(m.createdById) ?? null,
        href: m.meetLink ?? null,
      })
    ),
    ...openGoals.map((g) =>
      row('goal', 'goal_created', g.id, g.createdAt, {
        title: trim(g.title),
        detail: trim(g.description),
        actorRole: g.createdByRole,
      })
    ),
    ...doneGoals.map((g) =>
      row('goal', 'goal_completed', g.id, g.completedAt as Date, {
        title: trim(g.title),
        actorRole: g.createdByRole,
      })
    ),
    ...reports.map((r) =>
      row('report', 'report_submitted', r.id, r.createdAt, {
        weekStart: r.weekStart.toISOString(),
        detail: trim(r.summary),
        status: r.status,
      })
    ),
    ...decidedOffers.map((o) =>
      row('offer', offerEvent(o.status), o.id, o.decidedAt as Date, {
        title: trim(o.position),
        detail: o.company?.name ?? null,
        actor: o.decidedBy?.fullName ?? null,
      })
    ),
    ...sentOffers.map((o) =>
      row('offer', offerEvent(o.status), o.id, o.sentAt as Date, {
        title: trim(o.position),
        detail: o.company?.name ?? null,
        actor: o.createdBy?.fullName ?? null,
      })
    ),
    ...draftOffers.map((o) =>
      row('offer', offerEvent(o.status), o.id, o.createdAt, {
        title: trim(o.position),
        detail: o.company?.name ?? null,
        actor: o.createdBy?.fullName ?? null,
      })
    ),
    ...notes.map((n) =>
      row('note', 'note_added', n.id, n.createdAt, {
        detail: trim(n.body),
        actor: n.author?.fullName ?? null,
      })
    ),
  ];

  merged.sort((a, b) => {
    const diff = new Date(b.at).getTime() - new Date(a.at).getTime();
    return diff !== 0 ? diff : b.sortId.localeCompare(a.sortId);
  });

  const hasMore = merged.length > limit;
  const page = merged.slice(0, limit);
  const last = page[page.length - 1];

  return {
    entries: page.map(({ sortId: _sortId, ...entry }) => entry),
    nextCursor: hasMore && last ? formatCursor(last) : null,
    kinds: allowed,
  };
}

// A DRAFT offer has not been sent; it is an admin staging state and never
// visible to the mentor or the mentee, even indirectly (same rule the offers
// index applies).
// The three offer branches differ only in which column dated the row; the
// label always comes from the status, so an offer that expired without ever
// being decided never reads as "Offer sent".
function offerEvent(status: string): string {
  return status === 'DRAFT' ? 'offer_created' : `offer_${status.toLowerCase()}`;
}

function offerVisibility(role: TimelineViewerRole): WhereClause {
  return role === 'ADMIN' ? {} : { status: { not: 'DRAFT' } };
}
