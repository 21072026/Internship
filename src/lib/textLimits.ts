/**
 * Character limits for free-text fields — the single source of truth.
 *
 * WHY THIS EXISTS: the character-counter work (#782) set `maxLength` on the
 * client independently of the `zod` cap on the server and of the actual column
 * width in `prisma/schema.prisma`. All three drifted apart, and every
 * disagreement is a bug the user sees as an unexplained failure *after* they
 * finished typing:
 *
 *   - client cap > server cap  → a gray, reassuring "1 200/2 000" counter and
 *     then a bare 400 "Validation failed".
 *   - server cap > column width → Prisma P2000 ("Data too long"), which no
 *     route handles, so it surfaces as a 500.
 *
 * So: import these constants in BOTH the `zod` schema and the `<Textarea>`
 * `maxLength` prop for a field. Never inline a number in either place.
 *
 * INVARIANT — every value here must be <= what the column can hold:
 *   - `String` with no attribute is VARCHAR(191) in MySQL, so <= 191.
 *   - `@db.Text` is 65 535 *BYTES*, not characters. Turkish and German text in
 *     utf8mb4 runs 2-3 bytes per non-ASCII character, so a TEXT column safely
 *     holds ~21 000 worst-case characters. Keep TEXT-backed limits at or below
 *     20 000 unless the column is widened to `@db.MediumText`.
 */
export const TEXT_LIMITS = {
  /** InteractionLog.notes — @db.Text */
  interactionNotes: 5000,
  /** InteractionLog.subject — VARCHAR(191) */
  interactionSubject: 191,
  /** Company.description — @db.Text */
  companyDescription: 2000,
  /** MentorshipRequest.message — @db.Text */
  mentorshipRequestMessage: 1000,
  /** Public contact form message — Message.body, @db.Text */
  publicContactMessage: 2000,
  /** Announcement.text + Notification.text — @db.Text (fanned out per user) */
  announcementText: 20000,
  /** Announcement.link + Notification.link — @db.VarChar(500) */
  announcementLink: 500,
  /** Mentor bulk-email subject — prefixed into InteractionLog.notes */
  mentorEmailSubject: 200,
  /** Mentor bulk-email body — prefixed into InteractionLog.notes */
  mentorEmailBody: 4000,
  /** CompanyInterest.note — @db.Text */
  companyInterestNote: 1000,
  /** Message.body (conversation + support reply) — @db.Text */
  messageBody: 5000,
  /** SupportMessage.body — @db.Text */
  supportMessageBody: 5000,
  /** User.bio — @db.Text */
  bio: 2000,
  /** MentorApplication.experience — @db.Text */
  mentorApplicationExperience: 2000,
  /** MentorApplication.motivation — @db.Text */
  mentorApplicationMotivation: 2000,
  /** WeeklyReport.summary — @db.Text */
  weeklyReportSummary: 10000,
  /** WeeklyReport.blockers — @db.Text */
  weeklyReportBlockers: 5000,
  /** WeeklyReport.mentorComment — @db.Text */
  weeklyReportMentorComment: 5000,
  // Newsletter issue (#1469). Deliberately tight: the whole point of the format
  // is "little text, high quality" — a 20 000-character newsletter is a blog
  // post nobody reads on a phone. The caps are the format, not a storage limit
  // (Newsletter.content is Json/@db.Text and could hold far more).
  /** Newsletter subject line — Newsletter.subject is VarChar(300) */
  newsletterSubject: 200,
  /** Hidden inbox-preview line shown next to the subject */
  newsletterPreheader: 160,
  /** The one or two sentences above the tips */
  newsletterIntro: 600,
  /** One tip's heading */
  newsletterTipTitle: 120,
  /** One tip's body — one or two sentences, never a paragraph */
  newsletterTipBody: 400,
  /** The "do this in ten minutes" line under the tips */
  newsletterAction: 300,
  /** The extra block only mentors are shown */
  newsletterMentorNote: 600,
  /** Call-to-action button label */
  newsletterCtaLabel: 60,
  /** Call-to-action target — same width as Announcement.link */
  newsletterCtaUrl: 500,
  /** InvitationToken.label — the inviter's private note, VARCHAR(191) */
  invitationLabel: 120,
  /** InvitationToken.email — VARCHAR(191) */
  invitationEmail: 191,
  /** Bulk-invite full name (carried into the report only) — VARCHAR(191) */
  invitationFullName: 191,
} as const;

export type TextLimitKey = keyof typeof TEXT_LIMITS;
