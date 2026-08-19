// Merge a duplicate MENTEE into a primary one (#841) — the highest
// data-loss-risk operation in the app. Everything attached to the duplicate is
// re-pointed at the primary inside ONE transaction, unique collisions are
// resolved explicitly, and only then is the duplicate row deleted. Never
// automatic: callers must put a typed-confirmation + admin step-up in front.
//
// The inventory this implements was produced by diffing accountErasure.ts
// against the full schema: FK-backed relations, BARE user-id columns with no
// FK (Message.senderId, Evaluation.authorId, ActivityLog.actorId, …) that a
// relation walk misses, and three derived unique keys that EMBED user ids
// (CompanyInterest.scopeKey, InterviewRequest.activeKey,
// Conversation.directKey) which must be recomputed, not just re-pointed.
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { companyInterestScopeKey } from '@/lib/companyInterests';
import { interviewActiveKey } from '@/lib/interviewRequests';

export type MergeCounts = Record<string, number>;

export interface MergeResult {
  primaryId: string;
  duplicateId: string;
  duplicateEmail: string;
  counts: MergeCounts;
}

export class MergeError extends Error {
  constructor(
    public code:
      | 'same_user'
      | 'not_found'
      | 'org_mismatch'
      | 'not_mentee'
      | 'erased'
      | 'linked_by_mentorship',
    message: string,
  ) {
    super(message);
  }
}

type Tx = Prisma.TransactionClient;

// Children of MentorshipRelation, moved when two relations for the same
// mentor↔mentee pair collapse into one after re-pointing. WeeklyReport and
// WeeklyReportReminder have @@unique([relationId, weekStart]) and are handled
// separately.
const RELATION_CHILDREN = [
  'message',
  'offer',
  'evaluation',
  'mentorQuestion',
  'meetingRequest',
  'relationNote',
  'goal',
  'interactionLog',
  'meeting',
  'statusChange',
] as const;

function add(counts: MergeCounts, key: string, n: number) {
  if (n > 0) counts[key] = (counts[key] ?? 0) + n;
}

// Collapse `loser` relation into `survivor` (same mentor↔mentee pair after the
// merge re-point): move every child row, dedupe the weekStart-unique tables,
// then delete the loser.
async function mergeRelations(tx: Tx, survivorId: string, loserId: string, counts: MergeCounts) {
  for (const model of RELATION_CHILDREN) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const delegate = (tx as any)[model];
    const r = await delegate.updateMany({ where: { relationId: loserId }, data: { relationId: survivorId } });
    add(counts, `relation.${model}`, r.count);
  }
  for (const model of ['weeklyReport', 'weeklyReportReminder'] as const) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const delegate = (tx as any)[model];
    const survivorWeeks: { weekStart: Date }[] = await delegate.findMany({
      where: { relationId: survivorId },
      select: { weekStart: true },
    });
    const taken = new Set(survivorWeeks.map((w) => w.weekStart.getTime()));
    const loserRows: { id: string; weekStart: Date }[] = await delegate.findMany({
      where: { relationId: loserId },
      select: { id: true, weekStart: true },
    });
    for (const row of loserRows) {
      if (taken.has(row.weekStart.getTime())) {
        await delegate.delete({ where: { id: row.id } });
        add(counts, `relation.${model}.droppedDuplicateWeek`, 1);
      } else {
        await delegate.update({ where: { id: row.id }, data: { relationId: survivorId } });
        add(counts, `relation.${model}`, 1);
      }
    }
  }
  await tx.mentorshipRelation.delete({ where: { id: loserId } });
  add(counts, 'relation.collapsed', 1);
}

// Re-point one side (mentorId or menteeId) of MentorshipRelation, collapsing
// pairs that converge. There is NO @@unique([mentorId, menteeId]) on the model,
// so the DB never complains — the dedupe here is semantic. The survivor is the
// relation that already belonged to the primary (oldest as tiebreak).
async function repointRelationSide(tx: Tx, side: 'mentorId' | 'menteeId', duplicateId: string, primaryId: string, counts: MergeCounts) {
  const other = side === 'mentorId' ? 'menteeId' : 'mentorId';
  const dupRelations = await tx.mentorshipRelation.findMany({
    where: { [side]: duplicateId },
    orderBy: { startDate: 'asc' },
  });
  for (const rel of dupRelations) {
    const counterpart = rel[other as 'mentorId' | 'menteeId'];
    const existing = await tx.mentorshipRelation.findFirst({
      where: { [side]: primaryId, [other]: counterpart },
      orderBy: { startDate: 'asc' },
      select: { id: true },
    });
    if (existing) {
      await mergeRelations(tx, existing.id, rel.id, counts);
    } else {
      await tx.mentorshipRelation.update({ where: { id: rel.id }, data: { [side]: primaryId } });
      add(counts, 'mentorshipRelation', 1);
    }
  }
}

// Copy-if-empty scalar profile fields (the duplicate often carries data the
// primary lacks — e.g. a mentor-entered record with phone/university merged
// into a self-registered account that has only name+email).
const COPY_IF_EMPTY = [
  'phone',
  'whatsapp',
  'city',
  'birthDate',
  'university',
  'department',
  'graduationYear',
  'cvUrl',
  'avatarUrl',
  'displayName',
  'bio',
  'linkedinUrl',
  'githubUrl',
  'portfolioUrl',
  'interests',
  'targetPosition',
  'referralSource',
  'referredById',
  'preferredLanguage',
  'companyId',
  'sourceId',
  'consentAt',
] as const;

export async function mergeUsers(input: { primaryId: string; duplicateId: string }): Promise<MergeResult> {
  const { primaryId, duplicateId } = input;
  if (primaryId === duplicateId) throw new MergeError('same_user', 'Cannot merge a record into itself');

  const [primary, duplicate] = await Promise.all([
    prisma.user.findUnique({ where: { id: primaryId } }),
    prisma.user.findUnique({ where: { id: duplicateId } }),
  ]);
  if (!primary || !duplicate) throw new MergeError('not_found', 'User not found');
  if (primary.orgId !== duplicate.orgId) throw new MergeError('org_mismatch', 'Records belong to different organizations');
  if (primary.role !== 'MENTEE' || duplicate.role !== 'MENTEE') {
    throw new MergeError('not_mentee', 'Only candidate (MENTEE) records can be merged');
  }
  if (primary.email.endsWith('@erased.local') || duplicate.email.endsWith('@erased.local')) {
    throw new MergeError('erased', 'Erased records cannot be merged');
  }
  // A mentorship relation directly BETWEEN the two records means they are not
  // the same person (or the data needs untangling first) — deleting either
  // side would cascade real history away, so refuse instead of guessing.
  const linked = await prisma.mentorshipRelation.findFirst({
    where: {
      OR: [
        { mentorId: primaryId, menteeId: duplicateId },
        { mentorId: duplicateId, menteeId: primaryId },
      ],
    },
    select: { id: true },
  });
  if (linked) throw new MergeError('linked_by_mentorship', 'The two records are linked by a mentorship relation; resolve that first');

  const counts: MergeCounts = {};

  await prisma.$transaction(
    async (tx) => {
      // ── 1. Unique-constrained per-user rows: dedupe, then re-point ────────
      // UserConsent @@unique([userId, type]) — privacy-conservative merge: a
      // revocation on either account stays revoked on the survivor.
      const dupConsents = await tx.userConsent.findMany({ where: { userId: duplicateId } });
      for (const c of dupConsents) {
        const existing = await tx.userConsent.findUnique({
          where: { userId_type: { userId: primaryId, type: c.type } },
        });
        if (existing) {
          if (c.revokedAt && !existing.revokedAt) {
            await tx.userConsent.update({ where: { id: existing.id }, data: { revokedAt: c.revokedAt } });
          }
          await tx.userConsent.delete({ where: { id: c.id } });
          add(counts, 'userConsent.deduped', 1);
        } else {
          await tx.userConsent.update({ where: { id: c.id }, data: { userId: primaryId } });
          add(counts, 'userConsent', 1);
        }
      }

      // AvatarFile / CvFile: userId @unique, one row per user. Keep the
      // primary's when both exist (dup's is removed by the final cascade).
      for (const model of ['avatarFile', 'cvFile'] as const) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const delegate = (tx as any)[model];
        const primaryHas = await delegate.findUnique({ where: { userId: primaryId }, select: { userId: true } });
        if (!primaryHas) {
          const moved = await delegate.updateMany({ where: { userId: duplicateId }, data: { userId: primaryId } });
          add(counts, model, moved.count);
        }
      }

      // DocumentRequirementReminder — compound unique over both user columns;
      // pure delivery-idempotency markers, colliding rows are safe to drop.
      for (const col of ['menteeId', 'recipientId'] as const) {
        const rows = await tx.documentRequirementReminder.findMany({ where: { [col]: duplicateId } });
        for (const row of rows) {
          const target = { ...row, [col]: primaryId };
          const clash = await tx.documentRequirementReminder.findFirst({
            where: {
              requirementId: target.requirementId,
              menteeId: target.menteeId,
              recipientId: target.recipientId,
              weekStart: target.weekStart,
              id: { not: row.id },
            },
            select: { id: true },
          });
          if (clash) {
            await tx.documentRequirementReminder.delete({ where: { id: row.id } });
          } else {
            await tx.documentRequirementReminder.update({ where: { id: row.id }, data: { [col]: primaryId } });
          }
        }
        add(counts, 'documentRequirementReminder', rows.length);
      }

      // CompanyNeedAlert @@unique([companyId, menteeId]) — dedupe marker.
      const dupAlerts = await tx.companyNeedAlert.findMany({ where: { menteeId: duplicateId } });
      for (const a of dupAlerts) {
        const clash = await tx.companyNeedAlert.findFirst({
          where: { companyId: a.companyId, menteeId: primaryId },
          select: { id: true },
        });
        if (clash) await tx.companyNeedAlert.delete({ where: { id: a.id } });
        else await tx.companyNeedAlert.update({ where: { id: a.id }, data: { menteeId: primaryId } });
      }
      add(counts, 'companyNeedAlert', dupAlerts.length);

      // CompanyInterest — scopeKey @unique EMBEDS the menteeId; re-pointing
      // without recomputing leaves a stale key the upsert path never finds.
      const dupInterests = await tx.companyInterest.findMany({ where: { menteeId: duplicateId } });
      for (const ci of dupInterests) {
        const newKey = companyInterestScopeKey(ci.companyId, primaryId, ci.requisitionId);
        const existing = await tx.companyInterest.findUnique({ where: { scopeKey: newKey } });
        if (existing) {
          // Keep whichever row was touched last.
          if (ci.updatedAt > existing.updatedAt) {
            await tx.companyInterest.delete({ where: { id: existing.id } });
            await tx.companyInterest.update({ where: { id: ci.id }, data: { menteeId: primaryId, scopeKey: newKey } });
          } else {
            await tx.companyInterest.delete({ where: { id: ci.id } });
          }
          add(counts, 'companyInterest.deduped', 1);
        } else {
          await tx.companyInterest.update({ where: { id: ci.id }, data: { menteeId: primaryId, scopeKey: newKey } });
          add(counts, 'companyInterest', 1);
        }
      }

      // InterviewRequest — activeKey @unique embeds menteeId (null once decided).
      const dupInterviewReqs = await tx.interviewRequest.findMany({ where: { menteeId: duplicateId } });
      for (const ir of dupInterviewReqs) {
        let activeKey: string | null = null;
        if (ir.activeKey) {
          const newKey = interviewActiveKey(ir.requisitionId, primaryId);
          const clash = await tx.interviewRequest.findUnique({ where: { activeKey: newKey }, select: { id: true } });
          activeKey = clash ? null : newKey; // primary already has an active request → this one loses its active slot
        }
        await tx.interviewRequest.update({ where: { id: ir.id }, data: { menteeId: primaryId, activeKey } });
      }
      add(counts, 'interviewRequest', dupInterviewReqs.length);

      // ProjectMember @@unique([projectId, userId]) — keep the stronger role.
      const ROLE_RANK: Record<string, number> = { OWNER: 3, MENTOR: 2, MENTEE: 1 };
      const dupMemberships = await tx.projectMember.findMany({ where: { userId: duplicateId } });
      for (const m of dupMemberships) {
        const existing = await tx.projectMember.findUnique({
          where: { projectId_userId: { projectId: m.projectId, userId: primaryId } },
        });
        if (existing) {
          if ((ROLE_RANK[m.role] ?? 0) > (ROLE_RANK[existing.role] ?? 0)) {
            await tx.projectMember.update({ where: { id: existing.id }, data: { role: m.role } });
          }
          await tx.projectMember.delete({ where: { id: m.id } });
          add(counts, 'projectMember.deduped', 1);
        } else {
          await tx.projectMember.update({ where: { id: m.id }, data: { userId: primaryId } });
          add(counts, 'projectMember', 1);
        }
      }

      // ProjectJoinRequest @@unique([projectId, userId]) — APPROVED > PENDING > REJECTED.
      const REQ_RANK: Record<string, number> = { APPROVED: 3, PENDING: 2, REJECTED: 1 };
      const dupJoinReqs = await tx.projectJoinRequest.findMany({ where: { userId: duplicateId } });
      for (const r of dupJoinReqs) {
        const existing = await tx.projectJoinRequest.findFirst({
          where: { projectId: r.projectId, userId: primaryId },
        });
        if (existing) {
          const loser = (REQ_RANK[r.status] ?? 0) > (REQ_RANK[existing.status] ?? 0) ? existing : r;
          const winner = loser.id === r.id ? existing : r;
          if (winner.id === r.id) await tx.projectJoinRequest.update({ where: { id: r.id }, data: { userId: primaryId } });
          await tx.projectJoinRequest.delete({ where: { id: loser.id } });
          add(counts, 'projectJoinRequest.deduped', 1);
        } else {
          await tx.projectJoinRequest.update({ where: { id: r.id }, data: { userId: primaryId } });
          add(counts, 'projectJoinRequest', 1);
        }
      }

      // MenteeOnboarding @@unique([mentorId, menteeId]) — both columns can
      // carry the duplicate; union the checklist when rows converge.
      for (const col of ['mentorId', 'menteeId'] as const) {
        const other = col === 'mentorId' ? 'menteeId' : 'mentorId';
        const rows = await tx.menteeOnboarding.findMany({ where: { [col]: duplicateId } });
        for (const row of rows) {
          const counterpart = (row as Record<string, unknown>)[other] as string;
          if (counterpart === primaryId) {
            await tx.menteeOnboarding.delete({ where: { id: row.id } });
            continue;
          }
          const clash = await tx.menteeOnboarding.findFirst({
            where: { [col]: primaryId, [other]: counterpart },
          });
          if (clash) {
            const merged = {
              ...(typeof clash.steps === 'object' && clash.steps ? (clash.steps as Record<string, unknown>) : {}),
              ...(typeof row.steps === 'object' && row.steps ? (row.steps as Record<string, unknown>) : {}),
            };
            await tx.menteeOnboarding.update({ where: { id: clash.id }, data: { steps: merged as Prisma.InputJsonValue } });
            await tx.menteeOnboarding.delete({ where: { id: row.id } });
          } else {
            await tx.menteeOnboarding.update({ where: { id: row.id }, data: { [col]: primaryId } });
          }
        }
        add(counts, 'menteeOnboarding', rows.length);
      }

      // MessageReaction / MessageHiddenFor — bare userId columns but real
      // uniques; colliding duplicate rows carry no extra information.
      const dupReactions = await tx.messageReaction.findMany({ where: { userId: duplicateId } });
      for (const r of dupReactions) {
        const clash = await tx.messageReaction.findFirst({
          where: { messageId: r.messageId, userId: primaryId, emoji: r.emoji },
          select: { id: true },
        });
        if (clash) await tx.messageReaction.delete({ where: { id: r.id } });
        else await tx.messageReaction.update({ where: { id: r.id }, data: { userId: primaryId } });
      }
      add(counts, 'messageReaction', dupReactions.length);
      const dupHidden = await tx.messageHiddenFor.findMany({ where: { userId: duplicateId } });
      for (const h of dupHidden) {
        const clash = await tx.messageHiddenFor.findFirst({
          where: { messageId: h.messageId, userId: primaryId },
          select: { id: true },
        });
        if (clash) await tx.messageHiddenFor.delete({ where: { id: h.id } });
        else await tx.messageHiddenFor.update({ where: { id: h.id }, data: { userId: primaryId } });
      }
      add(counts, 'messageHiddenFor', dupHidden.length);

      // ── 2. Conversations: participants, then derived directKey ───────────
      const dupParticipations = await tx.conversationParticipant.findMany({
        where: { userId: duplicateId },
        include: { conversation: { select: { id: true, type: true, directKey: true } } },
      });
      for (const p of dupParticipations) {
        const existing = await tx.conversationParticipant.findUnique({
          where: { conversationId_userId: { conversationId: p.conversationId, userId: primaryId } },
        });
        if (existing) {
          const later =
            p.lastReadAt && (!existing.lastReadAt || p.lastReadAt > existing.lastReadAt) ? p.lastReadAt : existing.lastReadAt;
          await tx.conversationParticipant.update({ where: { id: existing.id }, data: { lastReadAt: later } });
          await tx.conversationParticipant.delete({ where: { id: p.id } });
          add(counts, 'conversationParticipant.deduped', 1);
        } else {
          await tx.conversationParticipant.update({ where: { id: p.id }, data: { userId: primaryId } });
          add(counts, 'conversationParticipant', 1);
        }
      }
      // Recompute directKey for every DIRECT conversation the duplicate was in.
      const directIds = [...new Set(dupParticipations.filter((p) => p.conversation.type === 'DIRECT').map((p) => p.conversationId))];
      for (const convId of directIds) {
        const conv = await tx.conversation.findUnique({
          where: { id: convId },
          include: { participants: { select: { userId: true } } },
        });
        if (!conv) continue; // already merged away below
        const ids = [...new Set(conv.participants.map((pp) => pp.userId))].sort();
        if (ids.length < 2) {
          // The "direct" conversation was between the two duplicate accounts —
          // both sides are now the primary. Keep the history but detach the
          // unique key so getOrCreateDirectConversation never resurrects it.
          await tx.conversation.update({ where: { id: convId }, data: { directKey: null } });
          add(counts, 'conversation.selfPairDetached', 1);
          continue;
        }
        const newKey = ids.join('|');
        if (conv.directKey === newKey) continue;
        const clash = await tx.conversation.findUnique({ where: { directKey: newKey }, select: { id: true } });
        if (clash && clash.id !== convId) {
          // Primary and duplicate each had a direct thread with the same third
          // person — fold this one into the surviving conversation.
          await tx.message.updateMany({ where: { conversationId: convId }, data: { conversationId: clash.id } });
          await tx.conversationParticipant.deleteMany({ where: { conversationId: convId } });
          await tx.conversation.delete({ where: { id: convId } });
          add(counts, 'conversation.folded', 1);
        } else {
          await tx.conversation.update({ where: { id: convId }, data: { directKey: newKey } });
          add(counts, 'conversation.rekeyed', 1);
        }
      }

      // ── 3. Mentorship relations (both sides, semantic dedupe) ────────────
      await repointRelationSide(tx, 'menteeId', duplicateId, primaryId, counts);
      await repointRelationSide(tx, 'mentorId', duplicateId, primaryId, counts);

      // MentorshipRequest: plain re-point, then keep only the newest PENDING.
      const movedReqs = await tx.mentorshipRequest.updateMany({ where: { menteeId: duplicateId }, data: { menteeId: primaryId } });
      add(counts, 'mentorshipRequest', movedReqs.count);
      const pending = await tx.mentorshipRequest.findMany({
        where: { menteeId: primaryId, status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      for (const extra of pending.slice(1)) {
        await tx.mentorshipRequest.delete({ where: { id: extra.id } });
        add(counts, 'mentorshipRequest.dedupedPending', 1);
      }

      // ── 4. Plain FK re-points (no unique constraints) ─────────────────────
      const plainFk: [string, string][] = [
        ['user', 'referredById'],
        ['pageView', 'userId'],
        ['notification', 'userId'],
        ['personalNote', 'userId'],
        ['document', 'ownerId'],
        ['document', 'uploaderId'],
        ['supportTicket', 'requesterId'],
        ['supportTicket', 'assignedAdminId'],
        ['supportMessage', 'senderId'],
        ['mentorshipRequest', 'decidedById'],
        ['mentorApplication', 'decidedById'],
        ['companyInquiry', 'handledById'],
        ['offer', 'createdById'],
        ['offer', 'decidedById'],
        ['project', 'ownerUserId'],
        ['projectTask', 'assigneeId'],
        ['projectTask', 'createdById'],
        ['projectTaskTemplate', 'createdById'],
        ['projectJoinRequest', 'decidedById'],
        ['availabilitySlot', 'mentorId'],
        ['relationNote', 'authorId'],
        ['statusChange', 'changedById'],
        ['invitationToken', 'invitedById'],
        ['weeklyReport', 'reviewedById'],
        ['requisition', 'ownerId'],
        ['interviewRequest', 'decidedById'],
      ];
      // Bare user-id columns with NO foreign key — invisible to a relation
      // walk; skipping any of these detaches history from the person.
      const bareColumns: [string, string][] = [
        ['message', 'senderId'],
        ['announcement', 'sentById'],
        ['aiUsage', 'userId'],
        ['evaluation', 'authorId'],
        ['mentorQuestion', 'askedById'],
        ['meetingRequest', 'requestedById'],
        ['meeting', 'createdById'],
        ['meetingSeries', 'createdById'],
        ['invitationToken', 'mentorId'],
        ['invitationToken', 'menteeId'],
        ['activityLog', 'actorId'],
        ['auditLog', 'actorId'],
      ];
      for (const [model, column] of [...plainFk, ...bareColumns]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const delegate = (tx as any)[model];
        const r = await delegate.updateMany({ where: { [column]: duplicateId }, data: { [column]: primaryId } });
        add(counts, `${model}.${column}`, r.count);
      }
      const audits = await tx.auditLog.updateMany({
        where: { targetId: duplicateId },
        data: { targetId: primaryId },
      });
      add(counts, 'auditLog.targetId', audits.count);

      // ── 5. Fold profile data into the primary ─────────────────────────────
      const data: Record<string, unknown> = {};
      for (const field of COPY_IF_EMPTY) {
        const p = primary[field as keyof typeof primary];
        const d = duplicate[field as keyof typeof duplicate];
        if ((p === null || p === undefined || p === '') && d !== null && d !== undefined && d !== '') data[field] = d;
      }
      const union = (a: unknown, b: unknown): string[] => [
        ...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])].map(String)),
      ];
      data.skills = union(primary.skills, duplicate.skills) as unknown as Prisma.InputJsonValue;
      data.languages = union(primary.languages, duplicate.languages) as unknown as Prisma.InputJsonValue;
      const levels = {
        ...(typeof duplicate.skillLevels === 'object' && duplicate.skillLevels ? (duplicate.skillLevels as object) : {}),
        ...(typeof primary.skillLevels === 'object' && primary.skillLevels ? (primary.skillLevels as object) : {}),
      };
      data.skillLevels = levels as Prisma.InputJsonValue;
      data.profileViews = (primary.profileViews ?? 0) + (duplicate.profileViews ?? 0);
      if (duplicate.lastSeenAt && (!primary.lastSeenAt || duplicate.lastSeenAt > primary.lastSeenAt)) data.lastSeenAt = duplicate.lastSeenAt;
      if (duplicate.lastLoginAt && (!primary.lastLoginAt || duplicate.lastLoginAt > primary.lastLoginAt)) data.lastLoginAt = duplicate.lastLoginAt;
      await tx.user.update({ where: { id: primaryId }, data: data as Prisma.UserUpdateInput });

      // ── 6. Delete the duplicate row ───────────────────────────────────────
      // Every Restrict FK is re-pointed above; the remaining Cascade relations
      // (tokens, SSO grants, page views already moved, …) go with the row.
      // referralCode is @unique but lives on the deleted row, so no collision.
      await tx.user.delete({ where: { id: duplicateId } });
    },
    { timeout: 120_000, maxWait: 10_000 },
  );

  return { primaryId, duplicateId, duplicateEmail: duplicate.email, counts };
}
