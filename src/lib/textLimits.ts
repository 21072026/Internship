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
  /** Company.name — VARCHAR(191) */
  companyName: 191,
  /** Company.description — @db.Text */
  companyDescription: 2000,
  /** Company.address — VARCHAR(191) */
  companyAddress: 191,
  /** Company.industry — VARCHAR(191) */
  companyIndustry: 191,
  /** Company.logoUrl — VARCHAR(191) */
  companyLogoUrl: 191,
  /**
   * Company.contactEmail — and CompanyInquiry.email, which is the same rule on
   * the same shape of column. Both VARCHAR(191). RFC 5321 allows an address up
   * to 254 characters; the column does not, so the shorter of the two is the
   * bound.
   */
  companyContactEmail: 191,
  /** Company.size — VARCHAR(191); the field holds a bracket label ("11-50") */
  companySize: 40,
  /**
   * Company.contactName — VARCHAR(191). The primary contact on an account
   * (#2407); a person's name, so the same bound as every other name column.
   */
  companyContactName: 191,
  /**
   * Company.contactPhone — VARCHAR(191). Capped far below the column, like
   * `companySize`: the longest E.164 number is 15 digits, and everything past
   * ~40 characters with separators and an extension is a paste, not a number.
   */
  companyContactPhone: 40,
  /**
   * Company.vatId — VARCHAR(191). The longest VAT identification number in the
   * EU scheme is 14 characters after the country prefix; 64 leaves room for a
   * non-EU tax id without letting a pasted paragraph reach the match key.
   */
  companyVatId: 64,
  /** Company.country — VARCHAR(2): an ISO-3166-1 alpha-2 code, nothing else. */
  companyCountry: 2,
  /** CompanyNeed.position — VARCHAR(191) */
  companyNeedPosition: 191,
  /** CompanyNeed.period — VARCHAR(191) */
  companyNeedPeriod: 191,
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
  /**
   * ProjectTask.title AND ProjectTaskTemplate.title — both VARCHAR(191).
   *
   * Two columns, five writers: a to-do you write yourself (`/api/todos`), a
   * project task, a rename (`/api/project-tasks/[taskId]`), the shared goal pool
   * (`/api/admin/goal-templates`) and a project's own pool
   * (`/api/projects/[id]/task-templates`). All five capped at 300 before #1433,
   * so a 250-character paste passed validation and died as a P2000 in the
   * driver. A template's wording becomes a task's title verbatim, so the two
   * columns cannot be bounded independently.
   */
  todoTitle: 191,
  /** InvitationToken.label — the inviter's private note, VARCHAR(191) */
  invitationLabel: 120,
  /** InvitationToken.email — VARCHAR(191) */
  invitationEmail: 191,
  /** Bulk-invite full name (carried into the report only) — VARCHAR(191) */
  invitationFullName: 191,

  // ── VARCHAR(191) columns whose zod cap used to be wider (#2262) ────────────
  // Each of these guarded a `String` column with no `@db.` attribute — MySQL
  // VARCHAR(191) — from a cap of 200, 300 or 500, or from no cap at all. Long
  // input therefore passed validation and died in the INSERT with Prisma P2000,
  // which no route handles: a 500 for text the form had just accepted.

  /** Project.name — VARCHAR(191) */
  projectName: 191,
  /**
   * Project.repoUrl / demoUrl / boardUrl — VARCHAR(191).
   * A legitimate URL longer than 191 characters exists but is rare (a deep link
   * into a hosted board). The column is what it is, so the bound matches it
   * rather than the column being widened for a case nobody has hit: a refusal
   * at the form is recoverable, a 500 after typing is not.
   */
  projectUrl: 191,
  /** Project.description — @db.Text */
  projectDescription: 5000,
  /** Project.goals — @db.Text */
  projectGoals: 5000,
  /** Goal.title — VARCHAR(191) */
  goalTitle: 191,
  /** Goal.description — @db.Text */
  goalDescription: 2000,
  /** MeetingRequest.topic — VARCHAR(191) */
  meetingTopic: 191,
  /** Document.title — VARCHAR(191) */
  documentTitle: 191,
  /** Organization.brandName — VARCHAR(191) */
  orgBrandName: 191,
  /**
   * Organization.brandColor — VARCHAR(191), holds a CSS colour ("#1d4ed8").
   * Capped far below the column for the same reason as `companySize`: the
   * field has a shape, and 191 characters of it is not a colour.
   */
  orgBrandColor: 40,
  /** Organization.supportEmail — VARCHAR(191) (see companyContactEmail on RFC 5321) */
  orgSupportEmail: 191,
  /** Organization.ssoIssuer — VARCHAR(191) */
  orgSsoIssuer: 191,
  /**
   * User.linkedinUrl / githubUrl / portfolioUrl and MentorApplication.linkedinUrl
   * — all VARCHAR(191). Same reasoning as `projectUrl`.
   */
  profileUrl: 191,
  /** User.city / university / department — VARCHAR(191), and previously uncapped */
  profileShortText: 191,
} as const;

export type TextLimitKey = keyof typeof TEXT_LIMITS;
