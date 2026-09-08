import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { logActivity } from '@/lib/activity';
import { notify } from '@/lib/notify';
import { emailAllowed } from '@/lib/notificationPrefs';
import { emailGroupAllowedForCategory } from '@/lib/emailGroups';
import {
  sendMentorAssignedEmail,
  sendMenteeAssignedEmail,
  sendRematchMentorNoticeEmail,
} from '@/services/emailService';
import { getMentorAvailability } from '@/lib/mentorAvailability';
import {
  findActiveMentorship,
  ALREADY_MENTORED_ERROR,
  AlreadyMentoredError,
} from '@/lib/activeMentorship';
import { ENDED_REASSIGNED, type AdminEndReasonCode } from '@/lib/relationLifecycle';
import { hasRelationHistory } from '@/lib/relationHistory';

// ---------------------------------------------------------------------------
// CHANGE THIS MENTEE'S MENTOR — one operation (#2289).
//
// Until this existed the only way to move a mentee from mentor A to mentor B
// was close-then-create: mark the relation COMPLETED, then assign the new
// mentor. Two unlinked writes, no reason recorded, and afterwards the record
// claims the first mentorship *finished successfully* — the same fake
// completion #1801 was filed to stop for the mentee-initiated case. The
// one-active-mentor guard (#419/#2283) then turned that into a visible dead
// end: assigning first answers 409, and nothing told the admin the sequence.
//
// There are two honest outcomes, and which one applies is a property of the
// DATA, not a choice the admin should have to make:
//
//   'corrected'   — the pairing has no history at all (no interaction, no
//                   message, no meeting, no goal, no evaluation, no stage move,
//                   …). Nothing happened under it, so nothing needs to be
//                   preserved: `mentorId` is repointed IN PLACE. This is the
//                   mis-assignment case — the admin picked the wrong name in
//                   the assign dialog — and it deserves a correction, not a
//                   closed relation standing as a record of a mentorship that
//                   never began. The audit trail is the ActivityLog entry.
//
//   'transferred' — the pairing HAS history. It is closed as ENDED_REASSIGNED
//                   with a reason, and a NEW relation is created for the
//                   incoming mentor, carrying `previousRelationId` back to it.
//
// Why 'transferred' never re-points `mentorId` on a relation that carries
// history: `InteractionLog` has no author column (prisma/schema.prisma) —
// a logged meeting is attributed purely through `relation.mentorId`. Repointing
// it would silently credit every meeting mentor A ran to mentor B, and any
// per-mentor reporting built on `relation.mentorId` would report it. For the
// same reason NOTHING is moved between the two relations: every child row stays
// where it was written, and the chain column is what makes the predecessor
// readable instead of merely still existing somewhere (docs/mentor-transfer.md).
//
// What the new relation DOES carry forward is the mentee's own journey:
// `pipelineStatus`, `stageDeadline`, company, project and cohort. Resetting a
// hired-track candidate to the first stage because their mentor changed is a
// second falsehood, and the one the pipeline board would show everybody.
// ---------------------------------------------------------------------------

export type TransferMode = 'corrected' | 'transferred';

export interface TransferResult {
  status: number;
  body: Record<string, unknown>;
}

/** Roles that can hold either side of a mentorship — same list as POST /api/mentorship (#1141). */
const PARTICIPANT_ROLES = ['ADMIN', 'MENTOR', 'MENTEE'];

export async function transferMentorship(opts: {
  relationId: string;
  toMentorId: string;
  reasonCode: AdminEndReasonCode;
  reasonNote?: string | null;
  actorId: string;
  actorEmail?: string | null;
  request?: Request;
}): Promise<TransferResult> {
  const { relationId, toMentorId, reasonCode, actorId, actorEmail, request } = opts;
  const reasonNote = opts.reasonNote?.trim() || null;

  const relation = await prisma.mentorshipRelation.findUnique({
    where: { id: relationId },
    select: {
      id: true,
      orgId: true,
      status: true,
      mentorId: true,
      menteeId: true,
      companyId: true,
      projectId: true,
      cohortId: true,
      pipelineStatus: true,
      stageDeadline: true,
      mentor: {
        select: {
          id: true,
          fullName: true,
          email: true,
          orgId: true,
          preferredLanguage: true,
          emailNotifications: true,
          notificationPrefs: true,
        },
      },
      mentee: {
        select: {
          id: true,
          fullName: true,
          email: true,
          orgId: true,
          emailNotifications: true,
          notificationPrefs: true,
        },
      },
      // Spelled out rather than derived from RELATION_HISTORY_COUNTS: Prisma's
      // `_count` select is a typed literal, and a computed object would need a
      // cast — which is how a renamed relation becomes a silent `undefined`
      // (read as "no history") instead of a compile error. The unit test pins
      // the two lists against each other.
      _count: {
        select: {
          interactions: true,
          statusChanges: true,
          meetings: true,
          messages: true,
          evaluations: true,
          goals: true,
          meetingRequests: true,
          questions: true,
          relationNotes: true,
          offers: true,
          weeklyReports: true,
        },
      },
    },
  });
  if (!relation) return { status: 404, body: { error: 'Relation not found' } };
  // Only a live pairing can be handed over. A closed one is reopened (PUT
  // /api/mentorship/[id]) or replaced by a fresh assignment — this operation
  // must not be a second way to resurrect one.
  if (relation.status !== 'ACTIVE') {
    return { status: 409, body: { error: 'The mentorship is not active', code: 'inactive_relation' } };
  }
  if (toMentorId === relation.mentorId) {
    return { status: 400, body: { error: 'Pick a different mentor', code: 'same_mentor' } };
  }
  if (toMentorId === relation.menteeId) {
    return { status: 400, body: { error: 'A user cannot mentor themselves', code: 'self_mentor' } };
  }

  const incoming = await prisma.user.findUnique({
    where: { id: toMentorId },
    select: {
      id: true,
      role: true,
      isActive: true,
      fullName: true,
      email: true,
      orgId: true,
      emailNotifications: true,
      notificationPrefs: true,
      mentorCapacity: true,
      acceptingMentees: true,
    },
  });
  if (!incoming || !incoming.isActive || !PARTICIPANT_ROLES.includes(incoming.role)) {
    return { status: 400, body: { error: 'Invalid mentor', code: 'invalid_mentor' } };
  }

  // Advisory only, exactly like POST /api/mentorship and the request-approval
  // path: a full or paused mentor is still a valid destination — an admin
  // moving a mentee off a mentor who left has to put them somewhere. Counted
  // before the write, so it describes the load going in.
  const activeMenteeCount = await prisma.mentorshipRelation.count({
    where: { mentorId: toMentorId, status: 'ACTIVE' },
  });
  const availability = getMentorAvailability({
    mentorCapacity: incoming.mentorCapacity,
    activeMenteeCount,
    acceptingMentees: incoming.acceptingMentees,
  });
  const warnings: string[] =
    availability.status === 'at_capacity'
      ? ['mentor_at_capacity']
      : availability.status === 'not_accepting'
        ? ['mentor_not_accepting']
        : [];

  // No plan gate (#547) anywhere above, same reasoning as an approved re-match:
  // the tenant's ACTIVE relation count is unchanged — one closes as the other
  // opens — so a tenant at its limit can still fix a wrong assignment or
  // replace a mentor who left. Refusing here would strand the mentee on the
  // wrong mentor.

  // Which of the two outcomes applies, decided from the pairing's own rows and
  // nothing else (src/lib/relationHistory.ts).
  const mode: TransferMode = hasRelationHistory(relation._count) ? 'transferred' : 'corrected';

  // One transaction for both shapes. The guard is re-asked INSIDE it
  // (src/lib/activeMentorship.ts takes a TransactionClient for exactly this),
  // with `exceptRelationId` because THIS relation is part of the comparison —
  // and a rollback is what keeps the mentee from ending up with two live
  // mentors or with none. That indivisibility is the whole point of the
  // operation: close-then-create over two HTTP requests has a window where
  // neither is true, and it is the shape that would trip the future
  // `@@unique([activeMenteeKey])` backstop (#2286).
  let createdId: string | null = null;
  try {
    createdId = await prisma.$transaction(async (tx) => {
      const other = await findActiveMentorship(tx, relation.menteeId, { exceptRelationId: relation.id });
      if (other) throw new AlreadyMentoredError(relation.menteeId, other.id);

      if (mode === 'corrected') {
        // `status: 'ACTIVE'` in the where is the serializer for this row: a
        // concurrent close (Mark complete) makes this match zero rows and roll
        // the whole thing back, rather than quietly reviving a closed pairing.
        await tx.mentorshipRelation.update({
          where: { id: relation.id, status: 'ACTIVE' },
          data: { mentorId: toMentorId },
        });
        return null;
      }

      await tx.mentorshipRelation.update({
        where: { id: relation.id, status: 'ACTIVE' },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          lifecycleState: ENDED_REASSIGNED,
          // The code, not the note: see the column's comment in
          // prisma/schema.prisma. The note is audited below instead.
          endReasonCode: reasonCode,
        },
      });
      const created = await tx.mentorshipRelation.create({
        data: {
          mentorId: toMentorId,
          menteeId: relation.menteeId,
          orgId: relation.orgId,
          // The mentee's journey follows the mentee (see the header): the board
          // must not show a hired-track candidate back at the first stage
          // because their mentor changed.
          pipelineStatus: relation.pipelineStatus,
          stageDeadline: relation.stageDeadline,
          companyId: relation.companyId,
          projectId: relation.projectId,
          cohortId: relation.cohortId,
          previousRelationId: relation.id,
        },
        select: { id: true },
      });
      return created.id;
    });
  } catch (e) {
    if (e instanceof AlreadyMentoredError) {
      return { status: 409, body: { ...ALREADY_MENTORED_ERROR } };
    }
    // Zero rows matched the `status: 'ACTIVE'` update — somebody closed the
    // pairing while this ran. Same answer as finding it closed up front.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
      return { status: 409, body: { error: 'The mentorship is not active', code: 'inactive_relation' } };
    }
    throw e;
  }

  const newRelationId = createdId ?? relation.id;
  const outgoing = relation.mentor;
  const mentee = relation.mentee;

  // Everything below is deliberately outside the transaction: it must not run
  // if the write rolled back, and must not hold a transaction open across SMTP.
  //
  // No webhook is dispatched here on purpose. `mentorship.created` would be a
  // lie in 'corrected' mode (nothing was created) and the direct-dispatch call
  // sites are capped at ten by npm run check:events (#1697) — an eleventh is a
  // red build. A `mentorship.transferred` event belongs to the catalogue that
  // guard exists to make room for, raised through emit() rather than posted
  // from here.

  // The mentee. Told who their mentor is now — never the reason, which is the
  // admin's operational note and (in the `wrong_assignment` case) about the
  // admin's own slip.
  await notify(
    mentee.id,
    'mentorship.mentorChanged',
    { mentorName: incoming.fullName },
    '/portal'
  );
  // The incoming mentor gets the standard "a mentee was assigned to you" row —
  // the same one a direct assignment sends, because from their side that is
  // exactly what happened. No echo when the admin assigned themself (#886).
  if (toMentorId !== actorId) {
    await notify(toMentorId, 'mentorship_request.menteeAssigned', { menteeName: mentee.fullName }, '/mentor');
  }
  // The outgoing mentor. Two different truths, so two different messages: a
  // mis-assignment that was corrected never was their mentee, while a real
  // transfer ended a pairing they had been working. Never the reason, on the
  // same grounds #1801 keeps the re-match reason from them.
  if (outgoing.id !== actorId) {
    await notify(
      outgoing.id,
      mode === 'corrected' ? 'mentorship.assignmentCorrected' : 'mentorship.reassignedAway',
      { menteeName: mentee.fullName },
      '/mentor'
    );
  }

  if (
    mentee.email &&
    emailAllowed(mentee, 'mentorship') &&
    emailGroupAllowedForCategory(mentee, 'mentor-assigned')
  ) {
    try {
      await sendMentorAssignedEmail({
        to: mentee.email,
        menteeName: mentee.fullName,
        mentorName: incoming.fullName,
        orgId: mentee.orgId,
        userId: mentee.id,
      });
    } catch (e) {
      console.error('Mentor transfer mentee email failed:', e);
    }
  }
  if (
    incoming.email &&
    toMentorId !== actorId &&
    emailAllowed(incoming, 'mentorship') &&
    emailGroupAllowedForCategory(incoming, 'mentee-assigned')
  ) {
    try {
      await sendMenteeAssignedEmail({
        to: incoming.email,
        mentorName: incoming.fullName,
        menteeName: mentee.fullName,
        orgId: incoming.orgId,
        userId: incoming.id,
      });
    } catch (e) {
      console.error('Mentor transfer incoming email failed:', e);
    }
  }
  // Only a real transfer mails the outgoing mentor, and it reuses the re-match
  // notice: its copy is "your mentorship with X has ended — they are
  // continuing with another mentor", which is true of both paths and says
  // nothing about who decided or why. A corrected mis-assignment gets the
  // in-app row above and no mail — there is no mentorship to tell them ended.
  if (
    mode === 'transferred' &&
    outgoing.email &&
    outgoing.id !== actorId &&
    emailAllowed(outgoing, 'mentorship') &&
    emailGroupAllowedForCategory(outgoing, 'mentorship-decision')
  ) {
    try {
      await sendRematchMentorNoticeEmail({
        to: outgoing.email,
        mentorName: outgoing.fullName,
        menteeName: mentee.fullName,
        orgId: outgoing.orgId,
        locale: outgoing.preferredLanguage,
        userId: outgoing.id,
      });
    } catch (e) {
      console.error('Mentor transfer outgoing email failed:', e);
    }
  }

  // The reason CODE is an operational fact worth auditing, and in 'corrected'
  // mode this entry is the ONLY record that the wrong mentor was ever assigned
  // — the relation itself no longer says so. The free-text note rides along
  // because an admin wrote it about their own decision; it is not the mentee's
  // words (contrast the re-match note, which never leaves the admin queue).
  await logActivity({
    action: mode === 'corrected' ? 'mentorship.mentor_corrected' : 'mentorship.transferred',
    actorId,
    actorEmail: actorEmail ?? null,
    targetType: 'relation',
    targetId: newRelationId,
    detail:
      `mentee ${relation.menteeId} · ${relation.mentorId} → ${toMentorId} · reason ${reasonCode}` +
      (mode === 'transferred' ? ` · replaced relation ${relation.id}` : ' · in place') +
      (reasonNote ? ` · ${reasonNote}` : ''),
    request,
  });

  return {
    status: 200,
    body: {
      ok: true,
      mode,
      relationId: newRelationId,
      previousRelationId: mode === 'transferred' ? relation.id : null,
      mentorName: incoming.fullName,
      warnings,
    },
  };
}
