import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

// Shared erasure logic (EPIC: GDPR data retention). Two modes:
// - hardDeleteUser: same cascade cleanup as the existing self-service account
//   deletion (src/app/api/account/route.ts DELETE) — rows without a DB-level
//   cascade must be removed explicitly before the user row itself.
// - anonymizeUser: keeps the row (and its relations/audit trail intact for
//   analytics) but scrubs PII and removes uploaded file bytes. Preferred when
//   the candidate's history should stay visible to the org.
//
// Both modes stay MANUAL and admin-initiated (the double-gated admin endpoint,
// or the account holder's own DELETE /api/account). Nothing in
// src/lib/retention.ts erases on a timer — that is a deliberate product
// decision, recorded in docs/pii-access-lifecycle.md.

// The delivery log (#1194) is keyed by recipient address, not by user id, so
// neither erasure path reaches it through a relation — it has to be cleared
// explicitly or an erased person's address survives in it (#1211). Read the
// address BEFORE the row is deleted or rewritten, or there is nothing left to
// match on.
//
// NewsletterSend (#1469) stores the address for the same reason and needs the
// same treatment. Its FK to User cascades, so a hard delete would take it —
// but `anonymizeUser` KEEPS the user row, and without this line the real
// address would sit in the newsletter history of an account whose whole point
// is that it no longer identifies anybody. Deleted by both address and id so
// neither an already-detached row nor a renamed one is missed.
async function forgetEmailLog(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user?.email) return;
  await prisma.emailLog.deleteMany({ where: { to: user.email } });
  await prisma.newsletterSend.deleteMany({ where: { OR: [{ email: user.email }, { userId }] } });
}

// ── Free text: what each surface gets, and why (#2052) ───────────────────────
//
// Rewriting the `User` row is not erasure. Everything the person ever typed —
// and everything typed about them — lives in other tables, most of them with no
// FK to `User` at all, so no cascade and no `user.update` reaches it. Two
// different rules, because "anonymise" means different things per surface:
//
// 1. Content the person WROTE is TOMBSTONED, not deleted: the body is emptied
//    and the attachment rows are dropped, but the row survives. This reuses the
//    existing "delete for everyone" mechanism (`Message.deletedForEveryoneAt`,
//    src/app/api/messages/[id]/route.ts) so the other participant's thread
//    still reads as a conversation with a "message deleted" placeholder instead
//    of silently losing half its turns.
//      Message.body + MessageAttachment, SupportMessage.body +
//      SupportAttachment, SupportTicket.subject (copied verbatim from the first
//      80 characters of the requester's own first message — scrubbing the body
//      and leaving the subject would erase nothing), MentorshipRequest.message,
//      and the person's own PersonalNote rows (private to them, nobody else's
//      view depends on them, so those are deleted outright).
//
// 2. Content written ABOUT them is SCRUBBED: the free text goes, the row and
//    its dates/types/stage stay. Those columns are the organisation's
//    operational history and carry no PII once the prose is gone.
//      InteractionLog.notes + subject, RelationNote.body, and any PersonalNote
//      taken in a meeting that belongs to them.
//
// Scope of "about them": relation-scoped free text is scrubbed on relations
// where the erased person is the MENTEE — the relation whose subject they are.
// On a relation where they were the *mentor*, the same columns are a third
// party's record and erasing them would delete someone else's history; a hard
// delete removes those relations wholesale through the cascade anyway.
// `PersonalNote` is keyed to its *author*, never to the subject, so it is
// reached through `meetingId` → the meeting's relation (mentee = this person)
// or its DIRECT (1:1) conversation with them.
//
// KNOWN GAPS — deliberately not silent, tracked in #2106:
//   - a free-standing `PersonalNote` (`meetingId: null`) has no link to any
//     subject at all; there is no query that can tell a note about this person
//     from a note about anyone else, so it is left alone here.
//   - notes taken in a GROUP-conversation or project meeting the person
//     attended: the note is about the meeting, not about them.
//   - the remaining per-person free text inventoried in the header of
//     scripts/sanitize-db.mjs (Evaluation.comment/publicExcerpt,
//     WeeklyReport.summary/blockers/mentorComment, MentorQuestion,
//     MeetingRequest.topic, Goal.description, ProjectJoinRequest.message,
//     CompanyInterest.note, InterviewRequest.note, Offer notes,
//     StatusChange.reasonNote, Notification.text, ActivityLog/AuditLog detail).
//     That script already lists every one of them; #2106 brings this function
//     up to the same inventory. Anything added to the schema belongs in both.
//
// Emptying rather than nulling is forced by the schema: `Message.body`,
// `SupportMessage.body`, `PersonalNote.body`, `RelationNote.body` and
// `InteractionLog.notes` are all required columns, and an empty body is an
// already-reachable, already-rendered state on every one of those surfaces
// (an attachment-only support message, a tombstoned chat message). No schema
// change — nothing here adds a column.
function scrubFreeTextOps(userId: string, now: Date): Prisma.PrismaPromise<unknown>[] {
  // Relations whose subject this person is. Nested filters (not a pre-read list
  // of ids) so every statement stays inside the caller's $transaction.
  const asSubject = { relation: { menteeId: userId } };
  return [
    // ── Content the person WROTE → tombstone ────────────────────────────────
    // Attachments first: once the message row is masked there is no way back to
    // its bytes, and `MessageAttachment` is reached only through the message.
    prisma.messageAttachment.deleteMany({ where: { message: { senderId: userId } } }),
    // `Message.senderId` has NO foreign key to `User` (see prisma/schema.prisma
    // — the model declares `relation`, `conversation`, `attachments`,
    // `hiddenFor` and `reactions`, but no `sender`), so a hard delete does not
    // cascade here either: a conversation-layer message (`relationId: null`)
    // outlives the account entirely. Already-tombstoned rows keep their own
    // timestamp — re-stamping would rewrite when the sender deleted it.
    prisma.message.updateMany({
      where: { senderId: userId, deletedForEveryoneAt: null },
      data: { body: '', deletedForEveryoneAt: now },
    }),
    prisma.supportAttachment.deleteMany({ where: { message: { senderId: userId } } }),
    prisma.supportMessage.updateMany({ where: { senderId: userId }, data: { body: '' } }),
    prisma.supportTicket.updateMany({ where: { requesterId: userId }, data: { subject: null } }),
    // The person's own private notes: theirs alone, so deleted rather than kept
    // as an empty row. (A hard delete cascades these; anonymise does not.)
    prisma.personalNote.deleteMany({ where: { userId } }),
    // The mentee's own words in their self-serve mentorship request.
    prisma.mentorshipRequest.updateMany({ where: { menteeId: userId }, data: { message: null } }),

    // ── Content written ABOUT the person → scrub, keep the row ──────────────
    prisma.interactionLog.updateMany({ where: asSubject, data: { notes: '', subject: null } }),
    prisma.relationNote.updateMany({ where: asSubject, data: { body: '' } }),
    prisma.personalNote.updateMany({
      where: {
        OR: [
          { meeting: { relation: { menteeId: userId } } },
          { meeting: { conversation: { type: 'DIRECT', participants: { some: { userId } } } } },
        ],
      },
      data: { body: '' },
    }),
  ];
}

export async function hardDeleteUser(userId: string): Promise<void> {
  await forgetEmailLog(userId);
  // BEFORE the relations go: deleting a relation cascades to its meetings, and
  // `PersonalNote.meetingId` is SetNull — so a note taken in this person's
  // meeting would survive with its text intact and its only link to them
  // nulled, unreachable by any later query (#2052). One $transaction so a
  // partial scrub cannot happen; the deletes below keep their existing failure
  // mode (an FK that neither cascades nor is detached).
  await prisma.$transaction(scrubFreeTextOps(userId, new Date()));
  await prisma.mentorshipRelation.deleteMany({ where: { OR: [{ mentorId: userId }, { menteeId: userId }] } });
  await prisma.statusChange.deleteMany({ where: { changedById: userId } });
  // Optional references without a DB-level cascade (FK restrict) would abort
  // the delete instead of cascading — and the rows themselves belong to the
  // org, not to the user, so they are detached rather than deleted. Without
  // this, deleting a mentor who owns a project or an admin who is assigned a
  // support ticket failed with an opaque FK error.
  await prisma.supportTicket.updateMany({ where: { assignedAdminId: userId }, data: { assignedAdminId: null } });
  await prisma.mentorshipRequest.updateMany({ where: { decidedById: userId }, data: { decidedById: null } });
  await prisma.project.updateMany({ where: { ownerUserId: userId }, data: { ownerUserId: null } });
  await prisma.user.delete({ where: { id: userId } });
}

export async function anonymizeUser(userId: string): Promise<void> {
  // Before the address is rewritten to erased-*@erased.local below, or the log
  // keeps the real one forever.
  await forgetEmailLog(userId);
  await prisma.$transaction([
    // Remove uploaded file bytes; anonymize doesn't need the CV/photo to remain.
    prisma.cvFile.deleteMany({ where: { userId } }),
    prisma.avatarFile.deleteMany({ where: { userId } }),
    prisma.document.deleteMany({ where: { ownerId: userId } }),
    // Every free-text surface outside the User row — see scrubFreeTextOps. This
    // is the half that used to be missing: the row claimed to be anonymous
    // while the person's messages, their support thread and the notes written
    // about them sat untouched next to it.
    ...scrubFreeTextOps(userId, new Date()),
    // Revoke consents — nothing left to process on their behalf.
    prisma.userConsent.updateMany({ where: { userId }, data: { revokedAt: new Date() } }),
    prisma.user.update({
      where: { id: userId },
      data: {
        fullName: 'Erased candidate',
        email: `erased-${userId}@erased.local`,
        phone: null,
        whatsapp: null,
        city: null,
        // country and referralSource sit on the very row this rewrites and are
        // as identifying as the rest of it (scripts/sanitize-db.mjs treats all
        // three as PII); they were simply missed.
        country: null,
        referralSource: null,
        birthDate: null,
        university: null,
        department: null,
        bio: null,
        displayName: null,
        avatarUrl: null,
        cvUrl: null,
        linkedinUrl: null,
        githubUrl: null,
        portfolioUrl: null,
        interests: null,
        targetPosition: null,
        // Free text an admin wrote about this person ("call them in September,
        // they said …"). The re-engagement promise is void once the account is
        // erased, so the note goes with it.
        reEngageNote: null,
        skills: [],
        skillLevels: {},
        publicProfile: false,
        isActive: false,
      },
    }),
  ]);
}
