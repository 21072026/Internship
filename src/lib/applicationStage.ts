// The ONE writer of Application.stage (#1836), and the two write-through hooks
// that keep CompanyInterest and the interview queue from drifting away from it.
//
// Every stage change in the tree — the PATCH route, the bulk route, a company's
// shortlist, an approved interview request — ends in moveApplicationStage(): a
// guarded `updateMany` whose WHERE carries the stage the caller saw, plus
// exactly one ApplicationEvent, inside the caller's transaction. Zero rows
// updated means somebody else moved the row first, and the caller answers
// 409 `stage_conflict` instead of writing over them (the idiom of
// /api/interview-requests/[id]). A hand-rolled `prisma.application.update` of
// `stage` anywhere else is a bug: it would skip the event, the derived status
// and the race guard at once.
//
// What this module does NOT decide: who may move what. That is
// canPerformApplicationAction() in src/lib/applications.ts, and the flags it
// takes are derived by the route from the DATABASE — never from a request body.
import type { Prisma } from '@prisma/client';
import {
  applicationFromInterest,
  canTransition,
  requiresDispositionCode,
  statusForStage,
  type ApplicationStage,
  type DispositionCode,
  type InterestLike,
} from '@/lib/applications';

export type StageDb = Prisma.TransactionClient;

export interface StageMoveInput {
  applicationId: string;
  /** The stage the caller saw; it goes into the WHERE, so a stale caller loses. */
  expectedStage: string;
  toStage: ApplicationStage;
  actorId: string | null;
  note?: string | null;
  dispositionCode?: DispositionCode | null;
  now?: Date;
}

export type StageMoveResult =
  | { ok: true; fromStage: string; toStage: ApplicationStage }
  | { ok: false; reason: 'illegal_transition' | 'disposition_required' | 'stage_conflict' };

export async function moveApplicationStage(db: StageDb, input: StageMoveInput): Promise<StageMoveResult> {
  const { applicationId, expectedStage, toStage } = input;
  // Belt and braces: the route has already refused these, but the rule is
  // cheap and this is the last line before the write.
  if (!canTransition(expectedStage, toStage)) return { ok: false, reason: 'illegal_transition' };
  if (requiresDispositionCode(toStage) && !input.dispositionCode) return { ok: false, reason: 'disposition_required' };
  const now = input.now ?? new Date();
  const status = statusForStage(toStage);
  const note = input.note?.trim() || null;
  const changed = await db.application.updateMany({
    where: { id: applicationId, stage: expectedStage },
    data: {
      stage: toStage,
      status,
      ...(toStage === 'REJECTED' ? { dispositionCode: input.dispositionCode, dispositionNote: note } : {}),
      ...(status !== 'ACTIVE' ? { decidedAt: now } : {}),
      ...(toStage === 'WITHDRAWN' ? { withdrawnAt: now } : {}),
    },
  });
  if (changed.count !== 1) return { ok: false, reason: 'stage_conflict' };
  await db.applicationEvent.create({
    data: { applicationId, fromStage: expectedStage, toStage, actorId: input.actorId, note, createdAt: now },
  });
  return { ok: true, fromStage: expectedStage, toStage };
}

export interface InterestSyncResult {
  applicationId: string;
  created: boolean;
  /** True when a stage changed (a creation counts: null → the seed's stage). */
  moved: boolean;
  fromStage: string | null;
  toStage: ApplicationStage;
}

/**
 * Write-through from a company's interest flag (#1836): a requisition-scoped
 * shortlist creates the matching Application, a later flag moves it when the
 * move is legal, and an illegal one (an application already past the stage the
 * flag means, a flag the funnel does not know) leaves the application alone —
 * the flag is a signal, the application is the record. The mapping itself is
 * applicationFromInterest(), the only place the two vocabularies meet.
 */
export async function syncApplicationFromInterest(
  db: StageDb,
  params: { interest: InterestLike; orgId: string; actorId: string | null; now?: Date },
): Promise<InterestSyncResult | null> {
  const seed = applicationFromInterest(params.interest);
  if (!seed) return null;
  const now = params.now ?? new Date();
  const existing = await db.application.findUnique({
    where: { requisitionId_menteeId: { requisitionId: seed.requisitionId, menteeId: seed.menteeId } },
    select: { id: true, stage: true },
  });
  if (!existing) {
    const created = await db.application.create({
      data: {
        orgId: params.orgId,
        ...seed,
        decidedAt: seed.status === 'ACTIVE' ? null : now,
        events: { create: { fromStage: null, toStage: seed.stage, actorId: params.actorId, note: 'company shortlist', createdAt: now } },
      },
      select: { id: true },
    });
    return { applicationId: created.id, created: true, moved: true, fromStage: null, toStage: seed.stage };
  }
  if (existing.stage === seed.stage || !canTransition(existing.stage, seed.stage)) {
    return { applicationId: existing.id, created: false, moved: false, fromStage: existing.stage, toStage: seed.stage };
  }
  const moved = await moveApplicationStage(db, {
    applicationId: existing.id,
    expectedStage: existing.stage,
    toStage: seed.stage,
    actorId: params.actorId,
    note: seed.dispositionNote ?? 'company interest',
    dispositionCode: seed.dispositionCode,
    now,
  });
  return { applicationId: existing.id, created: false, moved: moved.ok, fromStage: existing.stage, toStage: seed.stage };
}

/**
 * Write-through from the interview queue (#1836): an approved interview
 * request moves the matching application to INTERVIEW when that move is legal
 * from where it stands (a shortlisted applicant). No application, or one
 * somewhere else in the funnel, means nothing happens — the approval is never
 * refused for it.
 */
export async function advanceApplicationOnInterview(
  db: StageDb,
  params: { requisitionId: string; menteeId: string; actorId: string | null; now?: Date },
): Promise<{ applicationId: string; fromStage: string } | null> {
  const app = await db.application.findUnique({
    where: { requisitionId_menteeId: { requisitionId: params.requisitionId, menteeId: params.menteeId } },
    select: { id: true, stage: true },
  });
  if (!app || !canTransition(app.stage, 'INTERVIEW')) return null;
  const moved = await moveApplicationStage(db, {
    applicationId: app.id,
    expectedStage: app.stage,
    toStage: 'INTERVIEW',
    actorId: params.actorId,
    note: 'interview request approved',
    now: params.now,
  });
  return moved.ok ? { applicationId: app.id, fromStage: app.stage } : null;
}

// ── Who sees which rows ───────────────────────────────────────────────────────

export interface ApplicationActor {
  id: string;
  role: string;
  orgId: string;
  companyId: string | null;
}

/**
 * The rows an actor may see at all, as a Prisma filter — the same shape every
 * reader of applications uses, so "not yours" is a 404 everywhere and never a
 * 403 that confirms the id (#2542). ADMIN: the org. COMPANY: applications to
 * its own requisitions. MENTEE: its own. MENTOR: mentees it actively mentors.
 * Null for an actor the funnel does not know, or a company login without a
 * company.
 */
export function visibleApplicationsWhere(actor: ApplicationActor): Prisma.ApplicationWhereInput | null {
  switch (actor.role) {
    case 'ADMIN':
      return { orgId: actor.orgId };
    case 'COMPANY':
      return actor.companyId ? { orgId: actor.orgId, requisition: { companyId: actor.companyId } } : null;
    case 'MENTEE':
      return { orgId: actor.orgId, menteeId: actor.id };
    case 'MENTOR':
      return { orgId: actor.orgId, mentee: { menteeRelations: { some: { mentorId: actor.id, status: 'ACTIVE', orgId: actor.orgId } } } };
    default:
      return null;
  }
}

/** The authorization flags for a row the actor was allowed to load — derived from the row, never from a body. */
export function actorFlagsFor(actor: ApplicationActor, row: { menteeId: string; requisition: { companyId: string } }) {
  return {
    role: actor.role,
    isOwnApplication: actor.role === 'MENTEE' && row.menteeId === actor.id,
    isOwningCompany: actor.role === 'COMPANY' && actor.companyId !== null && row.requisition.companyId === actor.companyId,
    // A MENTOR only ever loads rows through the active-mentorship filter above,
    // so a loaded row IS one of their mentees' — no second lookup.
    isMenteesMentor: actor.role === 'MENTOR',
  };
}

/** What a stage write returns — never the disposition note (a reason is not read back to the person it is about, #1801). */
export const APPLICATION_SELECT = {
  id: true,
  orgId: true,
  requisitionId: true,
  menteeId: true,
  companyId: true,
  stage: true,
  status: true,
  source: true,
  dispositionCode: true,
  decidedAt: true,
  withdrawnAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ApplicationSelect;
