import { prisma } from '@/lib/prisma';
import { ambientOrgId, runUnscoped } from '@/lib/tenantAmbient';

// ── Settings resolution (#1553) ──────────────────────────────────────────────
//
// `Setting` is keyed by (orgId, programId, key). A row with neither id is the
// GLOBAL layer; a row with an orgId is one tenant's override; a row with an
// orgId AND a programId (#1619) is one programme's override inside that tenant.
// Every read resolves in exactly this order, and this file is the ONLY place
// that rule is written (`pickSetting()` below):
//
//   1. the programme row  (orgId = <tenant>, programId = <programme>) — only for
//                         a key whose SETTING_SCHEMA scopes include 'program'
//   2. the org row        (orgId = <tenant>, programId = NULL)
//   3. the global row     (orgId = NULL,     programId = NULL)
//   4. SETTING_DEFAULTS   (the code default, below)
//
// The typed, cached reader over this chain is `resolveSetting()` in
// src/lib/settingsResolver.ts (server-only); `getSetting()` / `getSettings()`
// below are the string-valued org → global → default readers it grew out of,
// kept for the callers #1621 has not moved yet.
//
// Which org a call resolves to: an explicit `orgId` argument wins; otherwise the
// org bound to the current request by `withTenantScope()` (`currentOrgId()`) —
// bound whether or not `MT_ENFORCE_ISOLATION` is on (#2628); otherwise none,
// which means the global layer alone. Callers without a bound tenant (layouts,
// crons, sessionless routes) pass the org explicitly, resolved by
// `src/lib/settingsOrg.ts` — never `null` for a tenant's own setting: the global
// row is the platform-wide default every tenant inherits, so a tenant write
// landing there is a write into every other tenant (#2628).
//
// Keys in GLOBAL_SETTING_KEYS (below) are the exception: deployment-wide by
// nature, resolved from the global layer only.
//
// WHY THESE QUERIES RUN UNSCOPED: `Setting` is registered in `TENANT_MODELS`
// (src/lib/orgContext.ts), so with enforcement on the tenant middleware would
// rewrite every query here to `where: { orgId: <tenant> }` — which is precisely
// the filter that would hide the global fallback row and make step 2 above
// unreachable. `unscopedSettings()` runs the query with the tenant context
// explicitly cleared so this module can see both layers; the org it then honours
// is computed here from `settingOrgId()`, never taken from request input. The
// registration still earns its keep: any *other* code that touches
// `prisma.setting` directly stays auto-scoped to its own tenant.
//
// Both of those come from `@/lib/tenantAmbient` rather than straight from
// `orgContext`: this module is reachable from a client component (a constant in
// documentAccess.ts, via retention.ts), and orgContext imports node:async_hooks,
// which webpack refuses to bundle for a client graph. The seam has no imports of
// its own; orgContext fills it in when it loads.

// Known settings with their defaults. Stored as strings; parsed on read.
export const SETTING_DEFAULTS = {
  reminderDays: '14',
  supportEmail: '',
  weeklyDigest: 'true',
  // Months of inactivity (unassigned + deactivated) before a candidate is
  // flagged "stale" for GDPR retention review. Informational only — no
  // automatic deletion; an admin reviews and erases manually.
  retentionMonths: '12',
  // Role-based two-factor enforcement. 'off' = optional for everyone;
  // 'admins' = required for ADMIN; 'admins_mentors' = required for ADMIN+MENTOR;
  // 'all' = every role (#1644). The vocabulary: src/lib/twoFactorPolicyRule.ts.
  // Users in scope are held at a 2FA-setup gate until they enable it.
  require2fa: 'off',
  // Password policy (#1544, src/lib/passwordPolicyRule.ts): what a NEW password
  // is judged by, per org, read by src/lib/password.ts for register, reset and
  // account and handed to the forms by GET /api/auth/password-policy. These
  // defaults ARE the rule the app always had; the minimum is clamped to >= 8
  // on read, so no row can make the rule weaker than the code default.
  passwordMinLength: '8',
  passwordRequireUpper: 'true',
  passwordRequireLower: 'true',
  passwordRequireDigit: 'false',
  passwordRequireSymbol: 'false',
  // Screen new passwords against Have I Been Pwned (k-anonymity: five hex
  // characters of the SHA-1 leave the box). Fails OPEN on an outage
  // (src/lib/breachedPassword.ts); 'false' switches the lookup off.
  breachedPasswordCheck: 'true',
  // Premium early-access window (#531): number of days a newly-hireable
  // (HIREABLE_600) candidate is visible in talent-pool search ONLY to companies
  // holding the EARLY_ACCESS entitlement, before opening to all subscribers.
  // '0' disables the window (everyone sees new candidates immediately).
  earlyAccessWindowDays: '7',
  // The hiring desk's stall clock (#1874): an open application whose latest
  // stage change is older than this many days is listed as stalled on
  // /admin/hiring. Clamped to 1…365 on read (src/lib/hiringQueues.ts).
  hiringStallDays: '14',
  // Open sign-up policy. 'auto' (default) = a self-registered account activates
  // itself the moment its email is verified, so the front door is genuinely
  // open; 'manual' = it stays inactive and waits for an admin (pendingApproval),
  // which is the escape hatch if sign-ups ever need vetting or get spammed.
  // Invited users are unaffected — an invitation already proves the email.
  selfRegistration: 'auto',
  // Monthly cap on AI provider calls across the org (Faz 2, #537). Every AI
  // feature consumes from this pool via runAiGated; '0' disables AI calls
  // entirely. Metered in AiUsage; resets each calendar month.
  aiMonthlyQuota: '200',
  // The org-wide AI kill switch (#2032): 'false' turns every task off with its
  // own honest denial ('disabled'), distinct from a spent quota. Read only
  // through src/lib/ai/policy.ts.
  aiEnabled: 'true',
  // Negative-outcome communication (#830). 'false' (default) means reaching an
  // outcome stage notifies the mentor and prefills a draft — a human reads,
  // edits and sends it. 'true' lets the templated message go out to the mentee
  // automatically. Off by default on purpose: a rejection is the most sensitive
  // text this product writes and the wrong message on the wrong case cannot be
  // recalled.
  outcomeAutoSend: 'false',
  // Blind interview review (#819). 'true' hides a candidate's name, photo and
  // university from an interviewer until that interviewer has submitted their
  // own scorecard. Off by default so nothing changes for an existing
  // installation; an org setting rather than a per-reviewer toggle, because a
  // bias control people opt into is one the reviewers who most need it skip.
  blindReview: 'false',
  // Accepted offer → hired stage (#2658). 'false' (default) keeps the offer
  // panel's suggestion and nothing moves by itself. 'true' moves the relation
  // to the pipeline's hired stage when an offer is accepted, through the same
  // write path as a move made by hand (src/lib/offerAutoAdvance.ts). Off by
  // default: some programmes only count a hire once the contract is signed.
  autoAdvanceOnOfferAccept: 'false',
  // Newsletter cadence (#1469). 'off' (default) means nothing is ever queued
  // automatically and every issue is scheduled by hand. 'weekly' / 'biweekly' /
  // 'monthly' let the daily queue job pick the next unused issue from the
  // curated library and SCHEDULE it — never send it directly, so an admin
  // always has the morning to read, edit or cancel what will go out.
  //
  // Off by default on purpose: the library ships in the repo, but which day a
  // real audience gets mail is a decision for whoever owns that audience.
  newsletterSchedule: 'off',
  // Who an auto-queued issue targets: MENTEE (default), MENTOR or BOTH.
  newsletterAudience: 'MENTEE',
  // Local hour of day an auto-queued issue is scheduled for (0-23).
  newsletterSendHour: '9',
  // Retention windows for the telemetry tables, in days (#1678). The daily
  // `retention.prune` job reads these; the reason for each number lives on its
  // registry entry in src/lib/retentionEntries.ts and in
  // docs/pii-access-lifecycle.md, which is the page an operator is pointed at
  // before changing one. They are deliberately NOT on the settings form: these
  // are operator decisions with a data-protection consequence, not preferences,
  // and a number typed into a form without the reasoning next to it is how a
  // published retention promise gets contradicted by accident.
  //
  // A value of 0, a negative or an unparseable one falls back to the entry's
  // default rather than deleting everything — a corrupted setting row must not
  // be able to empty a table.
  //
  // The security ledger: longest window, because it is what an incident review
  // reads. Evidence rows survive it; their ip/userAgent do not.
  activityLogRetentionDays: '365',
  // Per-user browsing history: shortest window, because it is the most invasive
  // and the least useful old — the one surface that reads it looks back 30 days
  // at most.
  pageViewRetentionDays: '180',
  // A push subscription neither delivered to nor re-confirmed within this
  // window, whose owner has also been quiet for it, is dead weight.
  pushSubscriptionStaleDays: '180',
  // Finished queue rows (SUCCEEDED/CANCELLED). DEAD_LETTER is never pruned.
  jobRetentionDays: '30',
  // The domain-event record (#1691, DomainEvent). Held only as long as a
  // receiver could still ask for a replay or a timeline could still read it.
  domainEventRetentionDays: '90',
  // Company enquiries (#2559): an unconverted one is deleted after this many
  // days, a converted one keeps its row and loses its personal columns.
  companyInquiryRetentionDays: '730',
  // Read access log (#2433): a repeat of the same read (same reader, record,
  // IP) inside this many minutes writes no second `*.view` ActivityLog row.
  // `0` = log every read; capped at a day; a blank or broken value falls back
  // to 15 rather than to "never log". The rule lives in src/lib/viewLogRule.ts.
  // Not on the settings form, like the retention windows above: it decides how
  // much of an audit trail is written, which is an operator decision.
  viewLogWindowMinutes: '15',
  // In-app notification rows (#1646). Unlike the four telemetry windows above
  // this one IS on the settings form, because it is the one an org actually has
  // an opinion about: a notification is a rendered sentence about a person plus
  // a link to their record — the same kind of data EmailLog is pruned for — and
  // how long a bell keeps its history is a programme decision, not an
  // infrastructure one.
  //
  // 180 days, matching PageView: half a year is far longer than anybody scrolls
  // back through a bell, and it is the window this product already publishes for
  // the other per-user history table, so there is one number to defend rather
  // than two. `0` means keep forever (the pre-#1646 behaviour, chosen
  // explicitly rather than by accident).
  //
  // Two rails live in the prune itself and no setting can lower them: an UNREAD
  // row is never deleted, and nothing younger than
  // NOTIFICATION_RETENTION_FLOOR_DAYS (30) is deleted whatever this says.
  notificationRetentionDays: '180',
  // Message retention (#2056), per tenant. Message BODIES older than this many
  // days are masked every night with the existing delete-for-everyone mechanism
  // (`deletedForEveryoneAt`, body emptied, attachments dropped) — the row stays,
  // so the other participant's thread stays coherent. `0` = keep forever, the
  // default and the behaviour before #2056: how long a programme keeps private
  // conversations is its own data-protection decision, not ours. Anything
  // positive is raised to MESSAGE_RETENTION_FLOOR_DAYS (30), so a typo cannot
  // mask yesterday's conversation. Edited on /admin/safeguarding.
  messageRetentionDays: '0',
  // The org's safeguarding watch list (#2056): one keyword or phrase per line,
  // parsed by `parseWatchKeywords` (src/lib/safeguarding.ts). Empty by default —
  // contact-detail detection works without it. Edited on /admin/safeguarding.
  safeguardingKeywords: '',
  // Board work-in-progress limit (#1439): a pipeline column holding more than
  // this many candidates gets an amber count, so a bottleneck stands out.
  // Advisory only — it never blocks a move.
  //
  // 8 because that is the number the board shipped with as a hardcoded
  // constant, so an installation that configures nothing sees the board it saw
  // yesterday. It was sized for one mentor's working set and does not survive
  // growth: at 308 relations every one of the thirteen columns breached it, and
  // a warning that fires everywhere is decoration. Hence a setting, a per-stage
  // override on `StageSla.wipLimit` (a funnel mouth and a hiring column have
  // very different healthy depths), and '0' here to switch WIP warnings off
  // entirely rather than pick a number nobody will act on.
  boardWipLimit: '8',
  // Grace period, in days, before the retention sweep ANONYMIZES an orphan
  // applicant account — a /apply account whose mentor declined and which shows
  // no other sign of life (#1780). The rule itself, and why 90 days, live in
  // src/lib/orphanApplicant.ts; the dry run an admin reads before it happens is
  // /admin/retention. Same fallback contract as the windows above: 0, negative
  // or unparseable falls back to the entry's default rather than erasing
  // everything. Unlike the windows above it is read from the GLOBAL layer only:
  // the sweep runs with no tenant bound and crosses every org in one pass, so a
  // per-tenant override would be written and never read — the admin dry run
  // reads the same layer deliberately, so its countdown is the one that fires.
  orphanApplicantGraceDays: '90',
  // Monthly cap on BROADCAST recipients — announcement e-mails and newsletter
  // issues — for one org (#1754). The rule, and everything it deliberately does
  // NOT meter, live in src/lib/broadcastQuota.ts.
  //
  // Default `''` = no override: the band is the plan's own
  // `monthlyBroadcastRecipients` (src/lib/plans.ts — Community 250, Program
  // 2 000, Program Plus 10 000, Enterprise unlimited), so an installation that
  // configures nothing gets the published packaging rather than a number
  // invented here. A value TIGHTENS that band and can never lift it, in either
  // layer: a cap a tenant's own admin could raise would protect nobody else's
  // deliverability, and every tenant shares one sending domain. `0` switches
  // broadcasts off entirely — 1:1 messages, notifications and every lifecycle
  // e-mail keep working, which is the point of metering only broadcasts.
  broadcastMonthlyRecipients: '',
  // Length of a MARKETING funnel trial, in days (#2551): when a record enters
  // the TRIAL_ACTIVE stage without a trial window, it is stamped
  // `trialStartedAt = entry` and `trialEndsAt = entry + this` — the date the
  // reminder ladder and the expiry sweep count from. 30 = a common free-use
  // period; the decision window after it is `decisionWindowDays`. Changing
  // it never moves a window already stamped (trialWindowFor() in
  // src/lib/trialReminderRule.ts refuses to overwrite one), and a blank,
  // zero or unparseable value falls back to 30 rather than stamping trials
  // that are over on arrival. On the settings form for MARKETING tenants only.
  trialLengthDays: '30',
  // The decision window of an expired MARKETING trial, in days (#2843, #2927):
  // after `trialEndsAt` the record waits in TRIAL_EXPIRED for a human to decide,
  // and the window closes this many days later — the owner is warned a week
  // before (src/lib/trialReminderRule.ts, parseDecisionWindowDays()). Derived on
  // read, never stamped, so a change applies to every expired trial at once. A
  // blank, zero or unparseable value falls back to 30; at most 365. On the
  // settings form for MARKETING tenants only.
  decisionWindowDays: '30',
  // The organization's own price list for the MARKETING /pricing page and the
  // landing FAQ (#2927): one JSON document, integer minor units + an ISO
  // currency, validated by src/lib/marketingPriceListRule.ts. Read for the org
  // bound to a marketing host (`Organization.publicHost`) only. `''` (default)
  // = no list: /pricing shows "pricing on request" and the FAQ names no figure;
  // a value that does not parse reads as that too (and is logged). Written by
  // the operator CLI `prisma/set-org-pricing.mjs` (dry run by default), not by
  // the settings form: it is a published price, and the CLI validates it before it is stored.
  marketingPriceList: '',
  // The letter a new postal campaign of this org starts from (#2697, #2927).
  // `''` (default) = the vertical's built-in letter
  // (src/lib/postCampaignTemplates.ts). Set from the acquisition page ("save
  // as our default letter"), through PUT /api/admin/post-campaigns/letter-template.
  postLetterTemplate: '',
  // Extra header spellings of the marketing import's `external_id` column
  // (src/lib/marketingImport.ts, parseHeaderAliases()): a comma- or
  // newline-separated list, e.g. the name the tenant's own export gives its
  // account id. `''` (default) = none — the canonical header and the generic
  // aliases always work. MARKETING only; written through PUT /api/admin/settings.
  importExternalIdAliases: '',
  // Who owns a new MARKETING lead nobody named an owner for (#2580 item 3,
  // #2569): a User id of this org (ADMIN or MENTOR, active). Read by the
  // marketing landing's demo form (the request lands straight on this person's
  // funnel at the first stage) and by the hand-typed lead route (#2562) when the
  // body names no owner. `''` (default) = no default owner: a form request then
  // stays in the admins' "unowned" list (/admin/company-inquiries) until an admin
  // converts it — never silently dropped. A stale id (the user left, was
  // deactivated, changed role or org) reads as `''` — resolveDefaultLeadOwner()
  // in src/lib/leadOwner.ts is the one reader. On the settings form for
  // MARKETING tenants only.
  defaultLeadOwnerId: '',
  // Monthly won-deal target per sales rep (MARKETING only). `''` (default) or
  // `0` = no target: the rep's card shows the plain count. The reading rule —
  // what counts as a win, how a broken value is read — is
  // src/lib/salesTargetRule.ts; on the settings form for MARKETING tenants only,
  // and the API refuses it for any other vertical.
  salesMonthlyWonTarget: '',
  // Show the team leaderboard (names + wins this month) to reps (MARKETING
  // only). Off by default: a leaderboard is something a team opts into. The
  // org's admins see it either way.
  salesLeaderboardForReps: 'false',
  // Outbound approval (#2960, docs/outbound-approval.md): 'off' (default) =
  // automated mail leaves as it always has; 'lead_mail' = every automated mail
  // to one of the org's leads or customers becomes a draft in the outbox
  // (/admin/outbox) until an operator sends, schedules or discards it. The
  // vocabulary and which mails are held: src/lib/outboundApprovalRule.ts.
  // MARKETING only: the settings API refuses it for any other vertical, and the
  // rule reads it as 'off' there whatever a row says.
  outboundApproval: 'off',
  // Meeting attendance (#2014): a cancellation this many hours or fewer before
  // the start is recorded as LATE_CANCEL for whoever cancelled.
  lateCancelHours: '24',
  // Evaluation due dates (#1891, src/lib/evaluationDue.ts). A stage KEY of the
  // tenant's own pipeline, never a label: '' means "the built-in default if
  // this pipeline has it" (INTERNSHIP_IN_PROGRESS_450 + 30 days for INTERIM,
  // INTERNSHIP_COMPLETED_490 for FINAL), 'off' switches that type off. The sweep
  // never guesses a stage a renamed pipeline does not have.
  evaluationInterimStage: '',
  evaluationInterimDays: '30',
  evaluationFinalStage: '',
  // BCC-to-CRM (#2809, docs/marketing-vertical/sales-email-capture.md): a mail
  // staff send with the org's `crm+…` address in BCC is logged on the matching
  // account. '' = the vertical's default (on for MARKETING, off for
  // INTERNSHIP); 'true' / 'false' = the org chose. The reading rule is
  // crmBccEnabledFor() in src/lib/crmBccRule.ts.
  crmBccEnabled: '',
  // The address's version: it is signed into the token, so bumping it (the
  // admin's "new address" button) makes the old address dead at once.
  crmBccVersion: '1',
  // Usage signals on the attention queue (#2449, src/lib/usageRule.ts):
  // `usage_drop` when the last half of the baseline is this many percent below
  // the half before it; an account whose usage history is shorter than the
  // baseline is left out and counted. `trial_inactive` when a trial has had no
  // usage at all this many days in. Read only while a usage feed has written
  // rows for the org; parsed by usageSignalSettings(), which falls back per field.
  usageDropThresholdPct: '40',
  usageBaselineDays: '60',
  trialActivationDays: '7',
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

// ── The typed catalogue (#1619) ──────────────────────────────────────────────
//
// One entry per key: what type the stored string parses to, and which layers
// may hold a row for it. The default stays the string in SETTING_DEFAULTS
// above (where each key's reasoning lives); `parseSettingValue()` turns it into
// the typed default the same way it turns a stored row into a value, so a key
// cannot have a default that disagrees with its own type.
//
//   number   — an integer; anything else reads as the default. Domain clamps
//              (a retention floor, a 1…365 range) stay in each key's own rule
//              module — this layer only refuses what is not a number at all.
//              `nullable: true` makes `''` read as `null` ("no override").
//   boolean  — 'true' / 'false'; anything else reads as the default.
//   enum     — one of `values`; anything else reads as the default.
//   string   — verbatim.
//   email    — a trimmed address, or '' (unset); a malformed one reads as ''.
//
// `scopes` lists the layers a row may live in. Every key has 'global'. A key
// without 'org' is deployment-wide (GLOBAL_SETTING_KEYS is derived from it).
// 'program' is opt-in, key by key: a programme override only exists for a
// decision that genuinely differs between two programmes of one tenant — the
// cadence and the rules of a programme's own pipeline — never for a security
// policy, a quota or a retention window, which bind the whole tenant.
export type SettingScope = 'global' | 'org' | 'program';

export type SettingSpec =
  | { type: 'number'; nullable?: boolean; scopes: readonly SettingScope[] }
  | { type: 'boolean'; scopes: readonly SettingScope[] }
  | { type: 'enum'; values: readonly string[]; scopes: readonly SettingScope[] }
  | { type: 'string'; scopes: readonly SettingScope[] }
  | { type: 'email'; scopes: readonly SettingScope[] };

const G = ['global'] as const;
const O = ['global', 'org'] as const;
const P = ['global', 'org', 'program'] as const;

export const SETTING_SCHEMA = {
  reminderDays: { type: 'number', scopes: P },
  supportEmail: { type: 'email', scopes: O },
  weeklyDigest: { type: 'boolean', scopes: O },
  retentionMonths: { type: 'number', scopes: O },
  require2fa: { type: 'enum', values: ['off', 'admins', 'admins_mentors', 'all'], scopes: O },
  passwordMinLength: { type: 'number', scopes: O },
  passwordRequireUpper: { type: 'boolean', scopes: O },
  passwordRequireLower: { type: 'boolean', scopes: O },
  passwordRequireDigit: { type: 'boolean', scopes: O },
  passwordRequireSymbol: { type: 'boolean', scopes: O },
  breachedPasswordCheck: { type: 'boolean', scopes: O },
  earlyAccessWindowDays: { type: 'number', scopes: O },
  hiringStallDays: { type: 'number', scopes: P },
  selfRegistration: { type: 'enum', values: ['auto', 'manual'], scopes: O },
  aiMonthlyQuota: { type: 'number', scopes: O },
  aiEnabled: { type: 'boolean', scopes: O },
  outcomeAutoSend: { type: 'boolean', scopes: P },
  blindReview: { type: 'boolean', scopes: P },
  autoAdvanceOnOfferAccept: { type: 'boolean', scopes: P },
  newsletterSchedule: { type: 'enum', values: ['off', 'weekly', 'biweekly', 'monthly'], scopes: O },
  newsletterAudience: { type: 'enum', values: ['MENTEE', 'MENTOR', 'BOTH'], scopes: O },
  newsletterSendHour: { type: 'number', scopes: O },
  activityLogRetentionDays: { type: 'number', scopes: G },
  pageViewRetentionDays: { type: 'number', scopes: G },
  pushSubscriptionStaleDays: { type: 'number', scopes: G },
  jobRetentionDays: { type: 'number', scopes: G },
  domainEventRetentionDays: { type: 'number', scopes: G },
  companyInquiryRetentionDays: { type: 'number', scopes: O },
  viewLogWindowMinutes: { type: 'number', scopes: G },
  notificationRetentionDays: { type: 'number', scopes: O },
  messageRetentionDays: { type: 'number', scopes: O },
  safeguardingKeywords: { type: 'string', scopes: O },
  boardWipLimit: { type: 'number', scopes: P },
  orphanApplicantGraceDays: { type: 'number', scopes: G },
  broadcastMonthlyRecipients: { type: 'number', nullable: true, scopes: O },
  trialLengthDays: { type: 'number', scopes: O },
  decisionWindowDays: { type: 'number', scopes: O },
  marketingPriceList: { type: 'string', scopes: O },
  postLetterTemplate: { type: 'string', scopes: O },
  importExternalIdAliases: { type: 'string', scopes: O },
  defaultLeadOwnerId: { type: 'string', scopes: O },
  salesMonthlyWonTarget: { type: 'number', nullable: true, scopes: O },
  salesLeaderboardForReps: { type: 'boolean', scopes: O },
  outboundApproval: { type: 'enum', values: ['off', 'lead_mail'], scopes: O },
  lateCancelHours: { type: 'number', scopes: P },
  evaluationInterimStage: { type: 'string', scopes: P },
  evaluationInterimDays: { type: 'number', scopes: P },
  evaluationFinalStage: { type: 'string', scopes: P },
  crmBccEnabled: { type: 'enum', values: ['', 'true', 'false'], scopes: O },
  crmBccVersion: { type: 'number', scopes: O },
  usageDropThresholdPct: { type: 'number', scopes: O },
  usageBaselineDays: { type: 'number', scopes: O },
  trialActivationDays: { type: 'number', scopes: O },
} as const satisfies { readonly [K in SettingKey]: SettingSpec };

type SpecValue<S> = S extends { type: 'number'; nullable: true }
  ? number | null
  : S extends { type: 'number' }
    ? number
    : S extends { type: 'boolean' }
      ? boolean
      : S extends { type: 'enum'; values: readonly (infer V)[] }
        ? V
        : string;

/** The parsed type of a setting: `SettingValue<'reminderDays'>` is `number`. */
export type SettingValue<K extends SettingKey> = SpecValue<(typeof SETTING_SCHEMA)[K]>;

/** Where a resolved value came from — the admin screen shows "inherited" by it. */
export type SettingSource = 'program' | 'org' | 'global' | 'default';

const INTEGER = /^\s*-?\d+\s*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseWith(spec: SettingSpec, raw: string): unknown {
  switch (spec.type) {
    case 'number':
      if (spec.nullable && raw.trim() === '') return null;
      return INTEGER.test(raw) ? Number.parseInt(raw, 10) : undefined;
    case 'boolean':
      return raw === 'true' ? true : raw === 'false' ? false : undefined;
    case 'enum':
      return spec.values.includes(raw) ? raw : undefined;
    case 'email': {
      const v = raw.trim();
      return v === '' || EMAIL.test(v) ? v : undefined;
    }
    case 'string':
      return raw;
  }
}

/**
 * Parse a stored string into the key's type. A value the type refuses reads as
 * the key's typed default — a corrupted row never reaches a caller as `NaN`.
 */
export function parseSettingValue<K extends SettingKey>(key: K, raw: string): SettingValue<K> {
  const spec: SettingSpec = SETTING_SCHEMA[key];
  const parsed = parseWith(spec, raw);
  if (parsed !== undefined) return parsed as SettingValue<K>;
  // The unit spec pins that every default parses under its own type.
  return parseWith(spec, SETTING_DEFAULTS[key]) as SettingValue<K>;
}

export function settingAllowsScope(key: SettingKey, scope: SettingScope): boolean {
  return (SETTING_SCHEMA[key].scopes as readonly SettingScope[]).includes(scope);
}

// Keys that belong to the DEPLOYMENT, not to a tenant (#2628). Each is read by
// something that runs with no tenant bound and crosses every org in one pass —
// the retention prune (`runRetentionPrune`, the orphan-applicant sweep) — or
// decides how much of the shared audit trail is written (`viewLogWindowMinutes`).
// A per-tenant row for one of them would be written and never be the number
// that fires, so none may exist: reads resolve these from the global layer
// alone, whatever org they are asked about, and `setSetting` refuses a tenant
// row for them. Writing them is a platform-operator (super admin) action — see
// PUT /api/admin/settings. The list is the keys whose SETTING_SCHEMA scopes
// stop at 'global' (today: the five telemetry retention windows,
// `viewLogWindowMinutes` and `orphanApplicantGraceDays`).
export const GLOBAL_SETTING_KEYS: ReadonlySet<SettingKey> = new Set<SettingKey>(
  (Object.keys(SETTING_SCHEMA) as SettingKey[]).filter((k) => !settingAllowsScope(k, 'org')),
);

export function isGlobalSettingKey(key: string): boolean {
  return GLOBAL_SETTING_KEYS.has(key as SettingKey);
}

// The org a settings call applies to. An explicit argument wins (including an
// explicit `null`, meaning "the global layer"); otherwise the request's bound
// tenant; otherwise none.
export function settingOrgId(orgId?: string | null): string | null {
  if (orgId !== undefined) return orgId;
  return ambientOrgId() ?? null;
}

// Run a Setting query with the tenant auto-filter switched off — see the header:
// the global fallback row (orgId = NULL) is invisible to a scoped query. This
// binds an empty tenant context, which the middleware skips; with enforcement
// off (or the engine not loaded at all) it is a plain passthrough.
function unscopedSettings<T>(fn: () => Promise<T>): Promise<T> {
  return runUnscoped(fn);
}

export type SettingRow = { orgId: string | null; programId: string | null; key: string; value: string };

/** The layers a read is asked about. `orgId: null` = no tenant (global only). */
export type ResolvedScope = { orgId: string | null; programId: string | null };

/**
 * THE resolution rule — programme row → org row → global row → default — over
 * rows already loaded. Pure, so the string readers below and the typed,
 * cached `resolveSetting()` (src/lib/settingsResolver.ts) answer the same
 * question the same way.
 *
 * A programme row counts only for a key whose scopes include 'program', and
 * only under the org it was asked for; an org row only for a key that is not
 * deployment-global. When a layer holds more than one row for the key (the
 * MySQL NULL-distinct wrinkle, see `setSetting`), the first one wins — callers
 * load newest first, so that is the row the writer last touched.
 */
export function pickSetting(
  rows: readonly SettingRow[],
  key: SettingKey,
  scope: ResolvedScope,
): { raw: string; source: SettingSource } {
  const { orgId, programId } = scope;
  if (orgId && programId && settingAllowsScope(key, 'program')) {
    const row = rows.find((r) => r.key === key && r.orgId === orgId && r.programId === programId);
    if (row) return { raw: row.value, source: 'program' };
  }
  if (orgId && settingAllowsScope(key, 'org')) {
    const row = rows.find((r) => r.key === key && r.orgId === orgId && r.programId === null);
    if (row) return { raw: row.value, source: 'org' };
  }
  const row = rows.find((r) => r.key === key && r.orgId === null && r.programId === null);
  if (row) return { raw: row.value, source: 'global' };
  return { raw: SETTING_DEFAULTS[key], source: 'default' };
}

/**
 * The `where` that loads every row `pickSetting` may need for `scope` — one
 * query whatever the number of keys. Newest first (see `pickSetting`).
 */
export function settingRowsQuery(scope: ResolvedScope, key?: SettingKey) {
  const { orgId, programId } = scope;
  const layers: { orgId: string | null; programId: string | null }[] = [{ orgId: null, programId: null }];
  if (orgId) layers.push({ orgId, programId: null });
  if (orgId && programId) layers.push({ orgId, programId });
  return {
    where: { ...(key ? { key } : {}), OR: layers },
    select: { orgId: true, programId: true, key: true, value: true },
    orderBy: [{ updatedAt: 'desc' as const }, { id: 'asc' as const }],
  };
}

// Writes so far in this process. The per-request cache in settingsResolver.ts
// drops what it holds when this moves, so a request that writes a setting and
// then reads it back sees its own write. Process-wide on purpose: a write in a
// concurrent request invalidates too, which costs one query and is never wrong.
let writeGeneration = 0;
export function settingsWriteGeneration(): number {
  return writeGeneration;
}

function loadRows(scope: ResolvedScope, key?: SettingKey): Promise<SettingRow[]> {
  return unscopedSettings(() => prisma.setting.findMany(settingRowsQuery(scope, key)));
}

// All settings for an org, with the global row and then the code default filled
// in for every key the org has not overridden. Programme rows are never read
// here — that layer is reached through resolveSetting() with a programId.
export async function getSettings(orgId?: string | null): Promise<Record<SettingKey, string>> {
  const scope = { orgId: settingOrgId(orgId), programId: null };
  const rows = await loadRows(scope);
  const map = {} as Record<SettingKey, string>;
  for (const key of Object.keys(SETTING_DEFAULTS) as SettingKey[]) map[key] = pickSetting(rows, key, scope).raw;
  return map;
}

// Read a single setting: tenant row → global row → default.
export async function getSetting(key: SettingKey, orgId?: string | null): Promise<string> {
  const scope = { orgId: settingOrgId(orgId), programId: null };
  return pickSetting(await loadRows(scope, key), key, scope).raw;
}

// Write one setting into a single layer — the org resolved exactly as reads
// resolve it, so a tenant admin can only ever write their own org's row and a
// single-tenant installation keeps writing the global one.
//
// `orgId` is a SERVER-SIDE argument (seeds, jobs, tests). Never pass a value
// that came from a request body: the authorization for this write is that the
// org is derived from the session's bound context, not from input. The same
// holds for `programId` (#1619): a programme row is written only for a key
// whose scopes include 'program', only under an explicit org, and only for a
// programme (Cohort) that belongs to that org — checked here, not trusted.
//
// Deliberately a read-modify-write rather than `prisma.setting.upsert`: the
// natural key contains nullable columns, so the compound unique cannot address
// an org row (programId = NULL) or the global row (both NULL). For the same
// reason the unique index does NOT stop two org rows for one key — MySQL treats
// NULLs as distinct — so this find-then-write is what keeps each layer single,
// and this function must stay the only writer of org and global rows.
export async function setSetting(
  key: SettingKey,
  value: string,
  orgId?: string | null,
  opts: { programId?: string } = {},
): Promise<void> {
  const org = settingOrgId(orgId);
  const programId = opts.programId ?? null;
  if (org !== null && isGlobalSettingKey(key)) {
    throw new Error(`Setting "${key}" is deployment-global and has no per-tenant row (#2628)`);
  }
  if (programId !== null) {
    if (!settingAllowsScope(key, 'program')) {
      throw new Error(`Setting "${key}" has no per-programme row (#1619)`);
    }
    if (org === null) throw new Error('A programme setting needs its org (#1619)');
  }
  await unscopedSettings(async () => {
    if (programId !== null) {
      const program = await prisma.cohort.findFirst({ where: { id: programId, orgId: org }, select: { id: true } });
      if (!program) throw new Error('Programme not found in this org (#1619)');
    }
    const existing = await prisma.setting.findFirst({
      where: { orgId: org, programId, key },
      select: { id: true },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    });
    if (existing) await prisma.setting.update({ where: { id: existing.id }, data: { value } });
    else await prisma.setting.create({ data: { orgId: org, programId, key, value } });
  });
  writeGeneration += 1;
}
