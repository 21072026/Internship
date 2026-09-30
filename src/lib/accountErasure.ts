import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { revokeAllTrustedDevices } from '@/lib/trustedDevice';
import { runUnscoped } from '@/lib/tenantAmbient';
import { defaultOrgId } from '@/lib/defaultOrg';
import {
  accountlessTombstoneId,
  companyContactErasureData,
  erasedAddress,
  erasureScoped,
  inquiryErasureData,
  normalizeContactEmail,
} from '@/lib/companyContactErasure';

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
//
// ONE PERSON, TWO WORLDS (#2590). The same address can be an account in the
// internship product AND in the marketing product — two `User` rows, two
// tenants. Both of those tables are keyed by ADDRESS, so "delete every row for
// this address" would erase the OTHER world's account's delivery log and
// newsletter history when only one world's account was erased. Erasure acts on
// exactly the one user row (every other table here is keyed by userId): the
// address-keyed sweep runs only when no other account still holds the address,
// and `NewsletterSend` rows that belong to this user by id are always removed.
// The other account is looked up outside the tenant filter — it lives in a
// different organization, which is the whole point. When the address survives
// on the other account, the delivery-log rows for it stay: they are the other
// account's own history, and there is no column that says which world sent
// one. Once that account is erased too, its own sweep finds no holder and
// clears them.
async function forgetEmailLog(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user?.email) return;
  const addressStillHeld =
    (await runUnscoped(() => prisma.user.count({ where: { email: user.email, id: { not: userId } } }))) > 0;
  if (addressStillHeld) {
    await prisma.newsletterSend.deleteMany({ where: { userId } });
    return;
  }
  await prisma.emailLog.deleteMany({ where: { to: user.email } });
  await prisma.newsletterSend.deleteMany({ where: { OR: [{ email: user.email }, { userId }] } });
}

// ── The person on a company record (#2434) ───────────────────────────────────
//
// "Erase the person, keep the company": the enquiry the person arrived through
// (`CompanyInquiry`) and the account whose primary contact they are
// (`Company.contact*`, #2407). The rule — which columns, which tenant's rows,
// and why — lives in src/lib/companyContactErasure.ts, where it is unit-tested;
// this is the Prisma-aware half.
//
// Returns OPS, not a promise, so each caller runs them inside its own
// $transaction next to the rest of its scrub: an erasure either rewrites the
// company side together with everything else or not at all.
//
// Same hard ordering as forgetEmailLog() above, and for the same reason — both
// tables are matched on the ADDRESS, so it must be read before the user row is
// rewritten (anonymise) or deleted (hard delete), or there is nothing left to
// match on. The org is read from the same row: it is the ERASED PERSON'S tenant
// that decides which rows are theirs, never an unfiltered match on the address,
// which would also rewrite another tenant's lead that happens to carry it.
async function companyContactOps(userId: string): Promise<Prisma.PrismaPromise<unknown>[]> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, orgId: true } });
  if (!user?.email) return [];
  return contactScrubOps(user.email, user.orgId, userId, await defaultOrgId());
}

/**
 * The two writes that forget a company contact, for both callers: an erased
 * ACCOUNT (above) and a contact who never had one (`forgetCompanyContact`,
 * #2559). One builder, so the two paths cannot scrub different columns or scope
 * the address differently — the #2434 rule is the whole rule for both.
 */
function contactScrubOps(
  email: string,
  subjectOrgId: string | null,
  tombstoneId: string,
  fallbackOrgId: string,
): [Prisma.PrismaPromise<Prisma.BatchPayload>, Prisma.PrismaPromise<Prisma.BatchPayload>] {
  return [
    prisma.companyInquiry.updateMany({
      where: erasureScoped({ email }, subjectOrgId, fallbackOrgId),
      data: inquiryErasureData(tombstoneId),
    }),
    // The company itself stays, with its name, needs, offers, requisitions,
    // interests and relations; only the named person on it goes.
    prisma.company.updateMany({
      where: erasureScoped({ contactEmail: email }, subjectOrgId, fallbackOrgId),
      data: companyContactErasureData(),
    }),
  ];
}

/**
 * Forget a company contact who has NO account (#2559, DSGVO Art. 17): a web
 * enquiry's sender or an imported account's named person. Matched on the
 * address inside ONE tenant — `orgId` is the requesting admin's org, and the
 * org-less/default rule is the same as for an erased account (rule 3 in
 * companyContactErasure.ts). One transaction; returns how many rows each table
 * gave up. A person who does have an account in this org goes through the
 * account erasure instead, which also reaches their messages and notes — the
 * route refuses the address before calling this.
 */
export async function forgetCompanyContact(
  email: string,
  orgId: string | null,
  randomId: string,
): Promise<{ inquiries: number; companies: number }> {
  const [inquiries, companies] = await prisma.$transaction(
    contactScrubOps(normalizeContactEmail(email), orgId, accountlessTombstoneId(randomId), await defaultOrgId()),
  );
  return { inquiries: inquiries.count, companies: companies.count };
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
//      CompanyInquiry.message (via companyContactOps, #2434), and the person's
//      own PersonalNote rows (private to them, nobody else's view depends on
//      them, so those are deleted outright).
//
// 2. Content written ABOUT them is SCRUBBED: the free text goes, the row and
//    its dates/types/stage stay. Those columns are the organisation's
//    operational history and carry no PII once the prose is gone.
//      InteractionLog.notes + subject, RelationNote.body, any PersonalNote
//      taken in a meeting that belongs to them, and — matched on their address,
//      inside their own tenant only — CompanyInquiry.contactName/email/phone/
//      note and Company.contactName/contactEmail/contactPhone (#2434).
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
// COVERAGE against the inventory in scripts/sanitize-db.mjs ("Emptied"), #2106.
// Every per-person free-text column listed there is scrubbed here, EXCEPT the
// ones below — each with the reason, so a gap is a decision, not an accident:
//   - a free-standing `PersonalNote` (`meetingId: null`) has no link to any
//     subject at all; there is no query that can tell a note about this person
//     from a note about anyone else, so it is left alone. Closing it needs a
//     product decision (an optional subject link, or notes that require a
//     context), not a query.
//   - notes and titles of a GROUP-conversation or project meeting the person
//     attended: they are about the meeting, not about them.
//   - the person QUOTED in someone else's text: an admin pasting their phone
//     number into a reply on a ticket another user opened, or a mentor naming
//     them in a free-standing note (#2098). Reachable only by full-text search,
//     and a search is not a key: it finds namesakes and misses a paraphrase,
//     and running one across private notes would itself read text nobody
//     asked the author to share. Not reached, by decision — the privacy notice
//     must say so (the wording is the rights holder's, not code's).
//   - `Meeting.meetLink`: a room URL, not personal data; sanitize-db drops it
//     only so a preview link cannot open a live room.
//   - `MenteeOnboarding.steps` and `Announcement`: checklist state and org-wide
//     broadcast copy, not text about a person.
//   - Notifications in OTHER people's bells that name this person ("Ayşe sent
//     you a message"): the name sits in `params` JSON beside no stable id, so
//     nothing can tell it from a namesake's (the `signup.companyInquiry` notice
//     every admin gets is the company-side case). Bounded instead by the
//     `notification` retention entry (notificationRetentionDays, 180 by
//     default). Their OWN bell is deleted above.
//   - The audit trail — `ActivityLog` (actorEmail, detail, ip, userAgent) and
//     `AuditLog.detail` — is KEPT, by decision: a ledger that erasure rewrites
//     cannot answer "who did what" for the security review or legal claim it
//     exists for (GDPR Art. 17(3)(b)/(e)). It is bounded by the `activityLog`
//     retention entry (activityLogRetentionDays, 365 by default), and nothing
//     here may start rewriting it without revisiting that decision in
//     docs/pii-access-lifecycle.md.
//   - a company contact who never had an ACCOUNT is not reachable from a `User`
//     row; `forgetCompanyContact()` below (#2559) forgets them by address
//     through the SAME scrub builder, and unconverted enquiries age out through
//     the `companyInquiry` retention entry.
// A new `@db.Text` column about a person belongs in BOTH lists — here and in
// the sanitize-db header — or in this block with its reason.
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
  // A meeting is about this person when it hangs off their relation
  // (`asSubject`), or off a DIRECT (1:1) conversation they are in (#1051 made
  // the second shape legal).
  const directMeeting = { conversation: { type: 'DIRECT' as const, participants: { some: { userId } } } };
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
    // Their own bell. A hard delete cascades it; anonymise used to keep every
    // rendered sentence ("Ayşe sent you a message", with the link) under a row
    // that claimed to be anonymous. Theirs alone, so deleted (#2106).
    prisma.notification.deleteMany({ where: { userId } }),
    // What they asked their mentor, and what they wrote on a project join
    // request (the decider's note on it is about them, so it goes too).
    prisma.mentorQuestion.updateMany({ where: { askedById: userId }, data: { question: '' } }),
    prisma.meetingRequest.updateMany({ where: { requestedById: userId }, data: { topic: '' } }),
    prisma.projectJoinRequest.updateMany({ where: { userId }, data: { message: null, decisionNote: null } }),
    // Their words as an AUTHOR, whoever the subject: an evaluation comment and
    // the excerpt that would be quoted from it, a mentor's answer, a weekly
    // report review. The scores and dates stay — the counterpart's record keeps
    // its shape, only the prose written by the erased person goes.
    prisma.evaluation.updateMany({ where: { authorId: userId }, data: { comment: null, publicExcerpt: null } }),
    prisma.mentorQuestion.updateMany({ where: { relation: { mentorId: userId } }, data: { answer: null } }),
    prisma.weeklyReport.updateMany({ where: { reviewedById: userId }, data: { mentorComment: null } }),

    // ── Content written ABOUT the person → scrub, keep the row ──────────────
    prisma.interactionLog.updateMany({ where: asSubject, data: { notes: '', subject: null } }),
    prisma.relationNote.updateMany({ where: asSubject, data: { body: '' } }),
    prisma.personalNote.updateMany({
      where: { OR: [{ meeting: asSubject }, { meeting: directMeeting }] },
      data: { body: '' },
    }),
    // The rest of the per-person inventory in scripts/sanitize-db.mjs (#2106).
    // Required columns are emptied, optional ones nulled; every date, status,
    // score and type stays. Most of these cascade on a hard delete (through the
    // relation or the user) and all of them survived anonymise — the gentler
    // mode the account page offers.
    prisma.evaluation.updateMany({
      where: { OR: [{ relation: { menteeId: userId } }, { subjectId: userId }] },
      data: { comment: null, publicExcerpt: null },
    }),
    prisma.weeklyReport.updateMany({ where: asSubject, data: { summary: '', blockers: null, mentorComment: null } }),
    prisma.mentorQuestion.updateMany({ where: asSubject, data: { question: '', answer: null } }),
    prisma.meetingRequest.updateMany({ where: asSubject, data: { topic: '' } }),
    // A meeting title often names the person ("Mock interview with Ayşe"), and
    // a cancel reason is free text about the same meeting. Only meetings that
    // are ABOUT them — their relation, or a 1:1 they were in; a project or
    // group meeting they attended is about the meeting.
    prisma.meeting.updateMany({
      where: { OR: [asSubject, directMeeting] },
      data: { title: '', cancelReason: null },
    }),
    prisma.goal.updateMany({ where: asSubject, data: { description: null } }),
    prisma.offer.updateMany({ where: asSubject, data: { compensationNote: null, declineNote: null } }),
    prisma.statusChange.updateMany({ where: asSubject, data: { reasonNote: null } }),
    prisma.companyInterest.updateMany({ where: { menteeId: userId }, data: { note: null } }),
    prisma.interviewRequest.updateMany({ where: { menteeId: userId }, data: { note: null, declineNote: null } }),
  ];
}

export async function hardDeleteUser(userId: string): Promise<void> {
  await forgetEmailLog(userId);
  // Built while the row — and with it the address and the org — still exists.
  const companyContact = await companyContactOps(userId);
  // BEFORE the relations go: deleting a relation cascades to its meetings, and
  // `PersonalNote.meetingId` is SetNull — so a note taken in this person's
  // meeting would survive with its text intact and its only link to them
  // nulled, unreachable by any later query (#2052). One $transaction so a
  // partial scrub cannot happen; the deletes below keep their existing failure
  // mode (an FK that neither cascades nor is detached).
  await prisma.$transaction([...scrubFreeTextOps(userId, new Date()), ...companyContact]);
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
  // keeps the real one forever. The company-side ops are matched on that same
  // address, so they are built here too — and run inside the transaction that
  // rewrites it, so the two cannot come apart (#2434).
  await forgetEmailLog(userId);
  const companyContact = await companyContactOps(userId);
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
    // The enquiry they sent and the company they are the contact of: the
    // person goes, the company and its history stay.
    ...companyContact,
    // Revoke consents — nothing left to process on their behalf.
    prisma.userConsent.updateMany({ where: { userId }, data: { revokedAt: new Date() } }),
    // And any outstanding password link. A hard delete takes these through the
    // cascade; anonymise keeps the row, so a live SET_INITIAL token (7-day TTL,
    // and every /apply account is issued one — #1780) would still set a
    // password on the account that was just erased. `/api/auth/reset` checks
    // only the token's own validity, not the state of the user behind it.
    prisma.passwordResetToken.deleteMany({ where: { userId } }),
    prisma.user.update({
      where: { id: userId },
      data: {
        fullName: 'Erased candidate',
        email: erasedAddress(userId),
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
        // An erased account must not keep a live session. `isActive` is only
        // read at sign-in, so without this cutoff the person whose data was
        // just scrubbed stayed signed in on their existing 12-hour JWT — and
        // browsing an anonymized profile of themselves. lib/auth.ts rejects
        // every token minted before this instant on its next request.
        sessionsValidFrom: new Date(),
      },
    }),
  ]);
  // And the remembered devices, or one of them silently mints a new session
  // moments later (docs/remember-me.md). A hard delete needs no equivalent:
  // TrustedDevice cascades with the user row.
  await revokeAllTrustedDevices(userId);
}
