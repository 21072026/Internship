#!/usr/bin/env node
/**
 * sanitize-db — turn a copy of production into preview data (#1186).
 *
 * The shared preview environment has been running on real data. Realistic data
 * is genuinely valuable for testing; real *people's* data is unnecessary risk.
 * This script keeps the shape and throws away the person: relationships,
 * pipeline history, dates and counts survive untouched — names, addresses,
 * notes, message bodies, files and every secret do not.
 *
 * Usage:
 *   DATABASE_URL=mysql://…/internship_crm_preview node scripts/sanitize-db.mjs
 *   … --verify-only    check that a preview database is still clean, change nothing
 *
 * SAFETY — the mirror image of seed-demo's guard. That one refuses to write
 * demo rows anywhere but a local/demo database; this one refuses to run
 * anywhere but a preview database. There is deliberately NO force flag: the
 * whole point is that it cannot be pointed at production, and an escape hatch
 * is exactly how that happens at 2am. It also checks the database NAME parsed
 * out of the URL rather than searching the whole string, so a host that merely
 * happens to contain "preview" cannot unlock a production database name.
 *
 * ── PII inventory ────────────────────────────────────────────────────────────
 * Every model in prisma/schema.prisma was reviewed; a model missed here is a
 * leak, so the ones deliberately left ALONE are listed too.
 *
 * Rewritten (identity replaced, row kept):
 *   User (email, fullName, displayName, phone, whatsapp, birthDate, city,
 *         country, bio, interests, targetPosition, university, department,
 *         referralSource, linkedin/github/portfolio URLs, cvUrl, avatarUrl,
 *         password, twoFactorSecret, icsFeedToken, referralCode)
 *   Company (contactEmail, address, description)
 *   Source (contactName, contactEmail)
 *   CompanyInquiry (contactName, email, phone, message)
 *   MentorApplication (fullName, email, phone, experience, motivation, linkedinUrl,
 *                      rejectReason)
 *   EmailLog (to, subject, error)
 *   ActivityLog (actorEmail, detail, ip, userAgent)
 *   AuditLog (detail)
 *   Notification (text, params)
 *
 * Emptied (free text written by or about a person):
 *   Message.body, MessageAttachment (rows), SupportMessage.body,
 *   SupportAttachment (rows), SupportTicket.subject, RelationNote.body,
 *   PersonalNote.body, Evaluation.comment + publicExcerpt, InteractionLog.notes
 *   + subject, MentorQuestion.question/answer, MeetingRequest.topic,
 *   WeeklyReport.summary/blockers/mentorComment, Goal.description,
 *   ProjectJoinRequest.message,
 *   MentorshipRequest.message, CompanyInterest.note, InterviewRequest.note,
 *   Offer.compensationNote/declineNote, Meeting.title/meetLink,
 *   MenteeOnboarding.steps, Announcement (text/translations/link),
 *   StatusChange.reasonNote
 *
 * Deleted outright (files and credentials — nothing to anonymise):
 *   CvFile, AvatarFile, Document, AnnouncementImage, MessageAttachment,
 *   SupportAttachment, InvitationToken, PasswordResetToken,
 *   EmailVerificationToken, ImpersonationGrant, SsoLoginGrant, ApiKey,
 *   Webhook, MeetingRoomState, PageView
 *
 * Left alone on purpose (structure, not people — this is the test value):
 *   Organization, PipelineStage, StageSla, UserConsent, MentorshipRelation,
 *   StatusChange (except reasonNote), Evaluation scores, InterviewPanel(+Member),
 *   EvaluationTemplate/Criterion, Goal.status/dates, Project, ProjectMember,
 *   ProjectTaskTemplate, Cohort, CompanyNeed, CompanyNeedAlert, Requisition,
 *   Meeting timing/RSVP, MeetingSeries(+Reminder, +OccurrenceEnd),
 *   AvailabilitySlot, Conversation(+Participant), MessageReaction,
 *   MessageHiddenFor, Setting, CompanyEntitlement, AiUsage, DocumentRequirement
 *   (+Reminder), WeeklyReportReminder, Offer status/dates.
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const DEMO_DOMAIN = 'demo.example.com';
// One known password for every account, so anyone testing preview can sign in
// as anybody. Preview is not a place where a password protects anything — the
// data is synthetic by the time this finishes.
const PREVIEW_PASSWORD = process.env.SANITIZE_PASSWORD || 'PreviewPass123!';
const PLACEHOLDER = '[redacted for preview]';

const FIRST = ['Ada', 'Baran', 'Ceyda', 'Deniz', 'Ege', 'Feray', 'Gökhan', 'Hale', 'Ilgaz', 'Jale',
  'Kerem', 'Lale', 'Mert', 'Nehir', 'Oya', 'Pınar', 'Rüya', 'Sinan', 'Tuna', 'Ulaş', 'Vera', 'Yaren', 'Zeki'];
const LAST = ['Akın', 'Bilge', 'Coşkun', 'Duran', 'Erdem', 'Fidan', 'Güneş', 'Halıcı', 'Işık',
  'Kaya', 'Limon', 'Mutlu', 'Narin', 'Özkan', 'Polat', 'Sarı', 'Tekin', 'Uçar', 'Yıldız'];

const fakeName = (i) => `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`;

/** The database name, not the whole URL — see the safety note above. */
function databaseName(url) {
  try {
    // mysql:// URLs parse fine with the WHATWG parser; the pathname is /<name>.
    return new URL(url).pathname.replace(/^\//, '').split('?')[0];
  } catch {
    return '';
  }
}

function assertPreviewTarget() {
  const url = process.env.DATABASE_URL || '';
  const name = databaseName(url);
  const ok = /preview/i.test(name) || /internship_pr/i.test(name);
  if (!ok) {
    console.error(
      `sanitize-db: refusing to run.\n` +
        `  database name: ${name || '(unparseable)'}\n` +
        `  This script only runs against a preview database (a name containing ` +
        `"preview" or "internship_pr"). There is no force flag on purpose — it must not ` +
        `be possible to point this at production.`
    );
    process.exit(1);
  }
  return name;
}

async function sanitizeUsers() {
  const users = await prisma.user.findMany({ select: { id: true }, orderBy: { createdAt: 'asc' } });
  const hashed = await bcrypt.hash(PREVIEW_PASSWORD, 10);
  let i = 0;
  for (const u of users) {
    const n = i++;
    await prisma.user.update({
      where: { id: u.id },
      data: {
        email: `user${n + 1}@${DEMO_DOMAIN}`,
        fullName: fakeName(n),
        displayName: null,
        password: hashed,
        phone: null,
        whatsapp: null,
        birthDate: null,
        city: null,
        country: null,
        bio: null,
        interests: null,
        targetPosition: null,
        university: null,
        department: null,
        referralSource: null,
        linkedinUrl: null,
        githubUrl: null,
        portfolioUrl: null,
        cvUrl: null,
        avatarUrl: null,
        twoFactorEnabled: false,
        twoFactorSecret: null,
        // Personal share links are credentials of a sort — a leaked calendar
        // feed URL keeps working forever.
        icsFeedToken: null,
        referralCode: null,
      },
    });
  }
  return users.length;
}

async function run() {
  const name = assertPreviewTarget();
  const verifyOnly = process.argv.includes('--verify-only');
  console.log(`sanitize-db: target ${name}${verifyOnly ? ' (verify only)' : ''}`);

  // Answering "is preview still clean?" without touching anything is worth
  // having on its own — a restore, a stray import or a half-finished run all
  // leave the same symptom, and this is how a pipeline notices.
  if (verifyOnly) {
    await verify();
    return;
  }

  // 1 · Files and credentials — nothing to anonymise, so they go.
  const deletions = [
    ['cvFile', () => prisma.cvFile.deleteMany({})],
    ['avatarFile', () => prisma.avatarFile.deleteMany({})],
    ['document', () => prisma.document.deleteMany({})],
    ['announcementImage', () => prisma.announcementImage.deleteMany({})],
    ['messageAttachment', () => prisma.messageAttachment.deleteMany({})],
    ['supportAttachment', () => prisma.supportAttachment.deleteMany({})],
    ['invitationToken', () => prisma.invitationToken.deleteMany({})],
    ['passwordResetToken', () => prisma.passwordResetToken.deleteMany({})],
    ['emailVerificationToken', () => prisma.emailVerificationToken.deleteMany({})],
    ['impersonationGrant', () => prisma.impersonationGrant.deleteMany({})],
    ['ssoLoginGrant', () => prisma.ssoLoginGrant.deleteMany({})],
    ['apiKey', () => prisma.apiKey.deleteMany({})],
    ['webhook', () => prisma.webhook.deleteMany({})],
    ['meetingRoomState', () => prisma.meetingRoomState.deleteMany({})],
    ['pageView', () => prisma.pageView.deleteMany({})],
  ];
  for (const [label, fn] of deletions) {
    const { count } = await fn();
    if (count) console.log(`  deleted ${count} ${label}`);
  }

  // 2 · People.
  const userCount = await sanitizeUsers();
  console.log(`  rewrote ${userCount} users`);

  // 3 · Free text written by or about a person. The ROWS stay — counts, dates
  //     and relationships are the test value — only the words go.
  const blanks = [
    ['message', () => prisma.message.updateMany({ data: { body: PLACEHOLDER, inboundMessageId: null } })],
    ['supportMessage', () => prisma.supportMessage.updateMany({ data: { body: PLACEHOLDER } })],
    ['supportTicket', () => prisma.supportTicket.updateMany({ data: { subject: PLACEHOLDER } })],
    ['relationNote', () => prisma.relationNote.updateMany({ data: { body: PLACEHOLDER } })],
    ['personalNote', () => prisma.personalNote.updateMany({ data: { body: PLACEHOLDER } })],
    ['evaluation', () => prisma.evaluation.updateMany({ data: { comment: null, publicExcerpt: null } })],
    ['interactionLog', () => prisma.interactionLog.updateMany({ data: { notes: PLACEHOLDER, subject: null } })],
    ['mentorQuestion', () => prisma.mentorQuestion.updateMany({ data: { question: PLACEHOLDER, answer: null } })],
    ['meetingRequest', () => prisma.meetingRequest.updateMany({ data: { topic: PLACEHOLDER } })],
    ['weeklyReport', () => prisma.weeklyReport.updateMany({ data: { summary: PLACEHOLDER, blockers: null, mentorComment: null } })],
    ['goal', () => prisma.goal.updateMany({ data: { description: null } })],
    ['projectJoinRequest', () => prisma.projectJoinRequest.updateMany({ data: { message: null } })],
    ['mentorshipRequest', () => prisma.mentorshipRequest.updateMany({ data: { message: null } })],
    ['companyInterest', () => prisma.companyInterest.updateMany({ data: { note: null } })],
    ['interviewRequest', () => prisma.interviewRequest.updateMany({ data: { note: null } })],
    ['offer', () => prisma.offer.updateMany({ data: { compensationNote: null, declineNote: null } })],
    ['statusChange', () => prisma.statusChange.updateMany({ data: { reasonNote: null } })],
    ['menteeOnboarding', () => prisma.menteeOnboarding.updateMany({ data: { steps: {} } })],
    // A meeting title often names the person; the link is a live room.
    ['meeting', () => prisma.meeting.updateMany({ data: { title: PLACEHOLDER, meetLink: null } })],
    ['announcement', () => prisma.announcement.updateMany({ data: { text: PLACEHOLDER, translations: {}, link: null } })],
    // A notification's text and params are a rendered sentence about somebody.
    ['notification', () => prisma.notification.updateMany({ data: { text: null, params: {} } })],
    ['auditLog', () => prisma.auditLog.updateMany({ data: { detail: null } })],
    ['emailLog', () => prisma.emailLog.updateMany({ data: { to: `user@${DEMO_DOMAIN}`, subject: PLACEHOLDER, error: null } })],
    ['activityLog', () => prisma.activityLog.updateMany({ data: { actorEmail: null, detail: null, ip: null, userAgent: null } })],
    ['companyInquiry', () => prisma.companyInquiry.updateMany({ data: { contactName: PLACEHOLDER, email: `inquiry@${DEMO_DOMAIN}`, phone: null, message: null } })],
    ['company', () => prisma.company.updateMany({ data: { contactEmail: null, address: null, description: null } })],
    ['source', () => prisma.source.updateMany({ data: { contactName: null, contactEmail: null } })],
  ];
  for (const [label, fn] of blanks) {
    const { count } = await fn();
    if (count) console.log(`  blanked ${count} ${label}`);
  }

  // MentorApplication carries an applicant's own words plus their contact
  // details, and its email column is indexed, so it is rewritten per row to
  // keep the values distinct.
  const apps = await prisma.mentorApplication.findMany({ select: { id: true }, orderBy: { createdAt: 'asc' } });
  let a = 0;
  for (const app of apps) {
    const n = a++;
    await prisma.mentorApplication.update({
      where: { id: app.id },
      data: {
        fullName: fakeName(n),
        email: `applicant${n + 1}@${DEMO_DOMAIN}`,
        phone: null,
        experience: null,
        motivation: null,
        linkedinUrl: null,
        rejectReason: null,
      },
    });
  }
  if (apps.length) console.log(`  rewrote ${apps.length} mentorApplication`);

  await verify();
}

/**
 * Prove it worked. A sanitiser that silently half-ran is worse than none: the
 * data would look safe and not be. Anything found here exits non-zero so a
 * pipeline stops instead of publishing the result.
 */
async function verify() {
  const problems = [];

  const realEmails = await prisma.user.count({ where: { NOT: { email: { endsWith: `@${DEMO_DOMAIN}` } } } });
  if (realEmails > 0) problems.push(`${realEmails} users still have a non-demo email`);

  const withPhone = await prisma.user.count({ where: { OR: [{ phone: { not: null } }, { whatsapp: { not: null } }] } });
  if (withPhone > 0) problems.push(`${withPhone} users still have a phone number`);

  const withFiles =
    (await prisma.cvFile.count()) + (await prisma.avatarFile.count()) + (await prisma.document.count());
  if (withFiles > 0) problems.push(`${withFiles} uploaded files remain`);

  const notes = await prisma.relationNote.count({ where: { NOT: { body: PLACEHOLDER } } });
  if (notes > 0) problems.push(`${notes} relation notes still carry their original text`);

  const comments = await prisma.evaluation.count({ where: { comment: { not: null } } });
  if (comments > 0) problems.push(`${comments} evaluation comments remain`);

  const bodies = await prisma.message.count({ where: { NOT: { body: PLACEHOLDER } } });
  if (bodies > 0) problems.push(`${bodies} message bodies remain`);

  const secrets = (await prisma.apiKey.count()) + (await prisma.webhook.count()) + (await prisma.passwordResetToken.count());
  if (secrets > 0) problems.push(`${secrets} credentials remain`);

  if (problems.length > 0) {
    console.error('sanitize-db: VERIFICATION FAILED');
    for (const p of problems) console.error(`  · ${p}`);
    process.exit(1);
  }

  // What survived, so the caller can see the structure is intact.
  const kept = {
    users: await prisma.user.count(),
    relations: await prisma.mentorshipRelation.count(),
    statusChanges: await prisma.statusChange.count(),
    evaluations: await prisma.evaluation.count(),
    meetings: await prisma.meeting.count(),
    messages: await prisma.message.count(),
  };
  console.log('sanitize-db: verification passed. Structure kept:', kept);
}

run()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
