// Images on a follow-up (#3931) — the only Prisma-aware half; the rules are
// src/lib/followUpImageRule.ts. Who may do what is the follow-up note's rule,
// asked in one place:
//   * WRITE (upload a draft, attach, clear) — whoever may write the follow-up
//     through PUT /api/mentorship/[id]: an admin holding `relation.write`, the
//     record's owner, or the org's sales dispatcher;
//   * READ — whoever may read the note (canSeeNextAction: the owner and the
//     admins), plus writers. The lead never.
// A record the caller may not read answers like a missing one (404).
import type { Session } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { actorFromSession, can, dispatcherMay } from '@/lib/authz';
import { relationSubject } from '@/lib/authzRule';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { canSeeNextAction } from '@/lib/nextActionRule';
import { FOLLOW_UP_IMAGE_DRAFT_TTL_MS, currentImages, planImageSet, type ImageSetPlan } from '@/lib/followUpImageRule';

export interface FollowUpImageAccess {
  relation: { id: string; orgId: string | null; mentorId: string; menteeId: string; cohortId: string | null; companyId: string | null };
  read: boolean;
  write: boolean;
}

export async function followUpImageAccess(session: Session, relationId: string): Promise<FollowUpImageAccess | null> {
  const relation = await prisma.mentorshipRelation.findFirst({
    where: withinTenant({ id: relationId }, await tenantWhere(session)),
    select: { id: true, orgId: true, mentorId: true, menteeId: true, cohortId: true, companyId: true },
  });
  if (!relation) return null;
  const actor = await actorFromSession(session);
  const admin = !!actor && (await can(actor, 'relation.write', relationSubject(relation), session));
  const write = admin || relation.mentorId === session.user.id || dispatcherMay(actor, 'relation.write', relation.orgId);
  const read = write || canSeeNextAction({ id: session.user.id, role: session.user.role }, relation);
  return { relation, read, write };
}

/** Metadata only — never the bytes. */
export const FOLLOW_UP_IMAGE_META = {
  id: true,
  contentType: true,
  size: true,
  attachedAt: true,
  clearedAt: true,
  uploaderId: true,
  createdAt: true,
} as const;

/** Drop the uploader's drafts nobody attached in time — on their next upload, so no job is needed. */
export async function sweepStaleDrafts(uploaderId: string, now: Date = new Date()) {
  await prisma.followUpImage.deleteMany({
    where: { uploaderId, attachedAt: null, createdAt: { lt: new Date(now.getTime() - FOLLOW_UP_IMAGE_DRAFT_TTL_MS) } },
  });
}

/** The plan for a write that names the follow-up's images (`wanted`), on this record. */
export async function planFollowUpImages(relationId: string, wanted: readonly string[], actorId: string): Promise<ImageSetPlan> {
  const rows = await prisma.followUpImage.findMany({
    where: { relationId, OR: [{ attachedAt: { not: null }, clearedAt: null }, { attachedAt: null, uploaderId: actorId }] },
    select: { id: true, attachedAt: true, clearedAt: true, uploaderId: true },
  });
  return planImageSet(rows, wanted, actorId);
}

/** The writes that carry out a plan — for the caller's transaction. */
export function applyImagePlan(plan: { attach: string[]; clear: string[] }, now: Date, moveTo?: string) {
  return [
    ...(plan.attach.length
      ? [prisma.followUpImage.updateMany({ where: { id: { in: plan.attach }, attachedAt: null }, data: { attachedAt: now, ...(moveTo ? { relationId: moveTo } : {}) } })]
      : []),
    ...(plan.clear.length ? [prisma.followUpImage.updateMany({ where: { id: { in: plan.clear }, clearedAt: null }, data: { clearedAt: now } })] : []),
  ];
}

/** The follow-up was cleared or completed: its images leave the panel, and stay in the history. */
export function clearCurrentImages(relationId: string, now: Date) {
  return prisma.followUpImage.updateMany({ where: { relationId, attachedAt: { not: null }, clearedAt: null }, data: { clearedAt: now } });
}

/** A kept follow-up travels to the new record with its images (hand-off, #3873). */
export function moveCurrentImages(fromRelationId: string, toRelationId: string) {
  return prisma.followUpImage.updateMany({
    where: { relationId: fromRelationId, attachedAt: { not: null }, clearedAt: null },
    data: { relationId: toRelationId },
  });
}

export { currentImages };
