#!/usr/bin/env node
// Guard: every free-text column in the schema has an erasure decision (#2098).
//
// WHY THIS EXISTS
//   Account erasure (src/lib/accountErasure.ts) reaches free text by KEY — the
//   author, the relation whose subject the person is, their address inside
//   their tenant. A column nobody added to that sweep is not an error anywhere:
//   it simply survives an anonymised account, under a row that claims to be
//   anonymous. #2052 and #2106 closed the inventory once; by #2098 ten more
//   `@db.Text` columns about a person (survey answers, cover notes, the mentor
//   application, a rematch reason…) had been added since and were reached by
//   neither path. The rule "a new free-text column about a person belongs in the
//   erasure sweep or in its COVERAGE block" lived only in a comment.
//
//   So every `@db.Text` / `@db.MediumText` / `@db.LongText` column must be listed
//   below as either
//     ERASED  — the sweep reaches it; checked: an erasure module touches the
//               model (`prisma.<model>.`) and either names the column or deletes
//               the rows (`<model>.deleteMany`), or
//     a reason — why erasing it is not erasure's job (configuration, a secret
//               that goes with its owner, a ledger kept by decision…).
//   A column in the schema and not here fails; an entry for a column that no
//   longer exists fails too (a stale decision reads like a live one).
//
// Run: node scripts/check-erasure-coverage.mjs   (npm run check:erasure-coverage)

import { readFileSync } from 'node:fs';

const SCHEMA_FILE = 'prisma/schema.prisma';
// The modules that make up the erasure sweep. `accountErasure.ts` is the entry
// point; the others are the halves it calls into.
const ERASURE_FILES = [
  'src/lib/accountErasure.ts',
  'src/lib/companyContactErasure.ts',
  'src/lib/externalProfileErasure.ts',
  'src/lib/outboundDrafts.ts',
  'src/lib/googleCalendarClient.ts',
  'src/lib/microsoftCalendarClient.ts',
];

const ERASED = 'ERASED';

// Reasons shared by many columns.
const CONFIG = 'org/product configuration or copy, written for everyone — not about a person';
const SECRET = 'a credential or cursor of an integration; goes with the connection, not with a person';
const OPS = 'operational error/diagnostic text of the platform, bounded by its own retention or row lifetime';
const BUSINESS = "the organisation's commercial record, not text about a person";

const DECISIONS = new Map([
  // ── Reached by the sweep ────────────────────────────────────────────────────
  ['User.bio', ERASED],
  ['User.interests', ERASED],
  ['User.reEngageNote', ERASED],
  ['Message.body', ERASED],
  ['MessageTemplate.title', ERASED], // the person's OWN templates (ownerId); org-wide ones are CONFIG
  ['Notification.text', ERASED],
  ['SupportMessage.body', ERASED],
  ['SupportReport.description', ERASED],
  ['MentorshipRequest.message', ERASED],
  ['MentorshipRequest.rematchNote', ERASED],
  ['MentorshipRequest.cancelReason', ERASED],
  ['CompanyInquiry.message', ERASED],
  ['CompanyInquiry.note', ERASED],
  ['MentorApplication.experience', ERASED],
  ['MentorApplication.motivation', ERASED],
  ['MentorApplication.rejectReason', ERASED],
  ['MentorApplication.adminNote', ERASED],
  ['MentorOffer.message', ERASED],
  ['MentorApplication.interviewNotes', ERASED],
  ['MentorApplication.referenceOutcome', ERASED],
  ['Offer.compensationNote', ERASED],
  ['Offer.declineNote', ERASED],
  // The frozen offer letter names the person and states their pay (#1857).
  ['Offer.letterSnapshot', ERASED],
  ['AiArtifact.content', ERASED],
  ['RequisitionFit.reason', ERASED],
  ['CompanyInterest.note', ERASED],
  ['RequisitionFit.reason', ERASED],
  ['CandidateOutreach.firstMessage', ERASED],
  ['ProjectJoinRequest.message', ERASED],
  ['ProjectJoinRequest.decisionNote', ERASED],
  ['Evaluation.comment', ERASED],
  ['Evaluation.publicExcerpt', ERASED],
  ['MentorQuestion.question', ERASED],
  ['MentorQuestion.answer', ERASED],
  ['PersonalNote.body', ERASED],
  ['RelationNote.body', ERASED],
  ['SessionNote.body', ERASED],
  ['SessionNoteRevision.body', ERASED],
  ['Goal.description', ERASED],
  ['Goal.successCriteria', ERASED],
  ['SessionAgendaItem.text', ERASED],
  ['InteractionLog.notes', ERASED],
  ['Meeting.cancelReason', ERASED],
  ['StatusChange.reasonNote', ERASED],
  ['RelationLifecycleEvent.reasonNote', ERASED],
  ['TrustedDevice.userAgent', ERASED],
  ['SignInDevice.userAgent', ERASED],
  ['NewsletterSend.error', ERASED],
  ['EmailLog.error', ERASED],
  ['ExternalProfileLink.consent', ERASED],
  ['ExternalProfileLink.attributes', ERASED],
  ['ExternalEvent.properties', ERASED],
  ['OutboundDraft.box', ERASED],
  ['OutboundDraft.summary', ERASED],
  ['WeeklyReport.summary', ERASED],
  ['WeeklyReport.blockers', ERASED],
  ['WeeklyReport.mentorComment', ERASED],
  ['InterviewRequest.note', ERASED],
  ['InterviewRequest.declineNote', ERASED],
  ['InterviewRequest.cancelReason', ERASED],
  ['Application.coverNote', ERASED],
  ['Application.dispositionNote', ERASED],
  ['ApplicationEvent.note', ERASED],
  ['MatchFeedback.reasonNote', ERASED],
  ['Placement.note', ERASED],
  ['MatchProposal.note', ERASED],
  ['MatchDecision.note', ERASED],
  ['RosterRowResult.message', ERASED],
  ['SurveyAnswer.text', ERASED],
  ['MeetingFeedback.note', ERASED],
  ['GoogleCalendarConnection.scope', ERASED],
  ['GoogleCalendarConnection.accessTokenEnc', ERASED],
  ['GoogleCalendarConnection.refreshTokenEnc', ERASED],
  ['GoogleCalendarConnection.lastError', ERASED],
  // Its provider-neutral successor (#1989): disconnect() deletes both rows.
  ['CalendarConnection.scope', ERASED],
  ['CalendarConnection.accessTokenEnc', ERASED],
  ['CalendarConnection.refreshTokenEnc', ERASED],
  ['CalendarConnection.lastError', ERASED],

  // ── Reached another way ─────────────────────────────────────────────────────
  ['DocumentReview.note', 'cascades with its Document, which both erasure paths delete (Document.ownerId)'],

  // ── Kept, by decision (accountErasure.ts COVERAGE, docs/pii-access-lifecycle.md) ──
  ['AuditLog.detail', 'the audit trail is kept by decision (Art. 17(3)(b)/(e)); bounded by activityLogRetentionDays'],
  ['ActivityLog.userAgent', 'the audit trail is kept by decision (Art. 17(3)(b)/(e)); bounded by activityLogRetentionDays'],
  ['SettingChange.oldValue', "an org's configuration history (#1623), not about a person: a key carrying personal data is flagged `redact` in SETTING_SCHEMA and stored as [redacted]; the actor is an id, read live"],
  ['SettingChange.newValue', 'see SettingChange.oldValue'],
  ['EmailSuppression.detail', 'the suppression list must outlive erasure, or an erased bounce/complaint address is mailed again'],
  ['EmailSuppression.releaseReason', "an admin's audited delist reason on the suppression list (see EmailSuppression.detail)"],
  ['EmailDeliveryEvent.detail', 'provider webhook log behind the suppression list; bounded by the emailDeliveryEvent retention entry'],
  ['ContactPermission.reason', 'proof of the contact basis (UWG § 7), kept after erasure for 3 years from the end of the erasure year, then deleted by the contactPermissionProof retention entry (#2098)'],
  ['AffiliatePartner.payoutDetailsCipher', 'payout record of a commercial partner, kept for the bookkeeping duty for 10 years from the end of the year the relationship ended, then cleared by the affiliatePayoutDetails retention entry (#2098)'],
  ['ApiImport.input', 'an API import payload, deleted at its own expiresAt'],
  ['ApiImport.report', 'an API import report, deleted at its own expiresAt'],
  ['ApiIdempotencyKey.responseBody', 'a replay cache for one API response, short-lived by design'],

  // ── Not about a person ──────────────────────────────────────────────────────
  ['Organization.brandLogoUrl', CONFIG],
  ['Organization.brandPalette', CONFIG],
  ['Organization.ssoEntryPoint', CONFIG],
  ['Organization.ssoCertificate', CONFIG],
  ['Organization.ssoLogoutUrl', CONFIG],
  ['Organization.ssoSpKey', CONFIG],
  ['Organization.ssoSpCert', CONFIG],
  ['Organization.ssoClientSecretEnc', CONFIG],
  ['Organization.ssoDiscoveryUrl', CONFIG],
  ['NotificationTemplate.body', CONFIG],
  ['OfferTemplate.bodyMarkdown', CONFIG],
  ['ContributorTerms.body', CONFIG],
  ['MentoringAgreement.body', CONFIG],
  ['Announcement.text', CONFIG],
  ['Setting.value', CONFIG],
  ['AgendaTemplateItem.guidance', CONFIG],
  ['MatchRuleSet.description', CONFIG],
  ['Project.description', CONFIG],
  ['ProgramEvent.description', CONFIG],
  ['Project.goals', CONFIG],
  ['Requisition.description', CONFIG],
  ['Company.description', 'describes the company, not its contact person (the contact columns are erased)'],
  ['CompanyInquiry.openRoles', "the company's roles, not the enquirer"],
  ['CompanyInquiry.marketplaces', "the company's sales channels, not the enquirer"],
  ['CompanyInquiry.referrer', 'origin+path of the referring page only (src/lib/inquiryAttribution.ts) — no query, no person'],
  ['PostCampaign.dataSource', BUSINESS],
  ['PostCampaign.balancingNote', BUSINESS],
  ['PostCampaign.letterBody', BUSINESS],
  ['PostCampaignRecipient.addressBlock', "a company's postal address on a sent letter campaign"],
  ['ProgramCost.note', BUSINESS],
  ['OrgEntitlement.note', BUSINESS],
  ['PlanChangeRequest.reason', BUSINESS],
  ['PlanChangeRequest.note', BUSINESS],
  ['ExternalCampaignStat.statistics', 'aggregate campaign counts, no person'],
  ['AuditDrain.url', SECRET],
  ['AuditDrain.lastError', OPS],
  ['ExternalConnection.sealedKey', SECRET],
  ['ExternalConnection.profilesPageCursor', SECRET],
  ['ExternalConnection.ignoredPhones', 'shared/office numbers the operator told the sync to skip — not one person'],
  ['ExternalSyncState.pageCursor', SECRET],
  ['RosterFeed.url', SECRET],
  ['RosterFeed.sftpPath', SECRET],
  ['RosterFeed.secretEnc', SECRET],
  ['RosterFeed.pausedReason', OPS],
  ['RosterRun.safetyReason', OPS],
  ['RosterRun.source', OPS],
  ['RosterRun.error', OPS],
  ['Job.lastError', OPS],
  // Webhook delivery log (#1695): the receiver's status text and a truncated response body — the
  // external system's answer to our signed payload, never text written about a person.
  ['WebhookDelivery.error', OPS],
  ['WebhookDelivery.responseBody', OPS],
  // Chat workspace install (#1934): sealed bot tokens, the granted OAuth scope list and ops errors.
  ['ChatWorkspace.botTokenEnc', SECRET],
  ['ChatWorkspace.refreshTokenEnc', SECRET],
  ['ChatWorkspace.scope', CONFIG],
  ['ChatWorkspace.lastError', OPS],
  ['ChatDelivery.error', OPS],
  ['JobRun.error', OPS],
  // A failed automation action's message (#1703): codes and driver errors, never text about a person.
  ['AutomationRun.error', OPS],
  // An admin-authored nudge's message (#1684): programme copy written for an
  // audience, with `{name}` filled per reader at send time — never stored per person.
  ['NudgeRule.bodyEn', CONFIG],
  ['NudgeRule.bodyTr', CONFIG],
  ['NudgeRule.bodyDe', CONFIG],
  // A receiver's answer to a webhook POST and our transport error (#1695):
  // truncated, and it goes with its DomainEvent under the event retention.
  ['WebhookDelivery.responseBody', OPS],
  // A chat workspace connection's sealed tokens, granted scope and last error,
  // and one chat delivery's transport error: the integration's, not a person's.
  ['ChatWorkspace.botTokenEnc', SECRET],
  ['ChatWorkspace.refreshTokenEnc', SECRET],
  ['ChatWorkspace.scope', SECRET],
  ['ChatWorkspace.lastError', OPS],
  ['ChatDelivery.error', OPS],
  ['WebhookDelivery.error', OPS],
  ['BackfillRun.lastError', OPS],
  ['NotificationDelivery.error', OPS],
]);

const lc = (s) => s[0].toLowerCase() + s.slice(1);

/** Every free-text column, as `Model.field`. Comment lines are skipped. */
export function textColumns(schema) {
  const out = [];
  let model = null;
  for (const raw of schema.split('\n')) {
    const line = raw.trim();
    const m = /^model\s+(\w+)\s*\{/.exec(line);
    if (m) {
      model = m[1];
      continue;
    }
    if (line === '}') {
      model = null;
      continue;
    }
    if (!model || line.startsWith('//')) continue;
    const f = /^(\w+)\s+String\??\s.*@db\.(?:Text|MediumText|LongText)\b/.exec(line);
    if (f) out.push(`${model}.${f[1]}`);
  }
  return out;
}

export function check(schema, erasureSource, decisions = DECISIONS) {
  const errors = [];
  const columns = textColumns(schema);
  const present = new Set(columns);
  for (const col of columns) {
    if (!decisions.has(col)) {
      errors.push(
        `${col}: a free-text column with no erasure decision. Reach it in src/lib/accountErasure.ts ` +
          `(and list it as ERASED here), or add it here with the reason it is not about a person.`,
      );
      continue;
    }
    if (decisions.get(col) !== ERASED) continue;
    const [model, field] = col.split('.');
    const touched = erasureSource.includes(`prisma.${lc(model)}.`);
    const named = new RegExp(`\\b${field}\\b`).test(erasureSource);
    const deleted = erasureSource.includes(`${lc(model)}.deleteMany`) || erasureSource.includes(`${lc(model)}.delete(`);
    if (!touched || !(named || deleted)) {
      errors.push(`${col}: listed as ERASED, but no erasure module touches prisma.${lc(model)} for it.`);
    }
  }
  for (const col of decisions.keys()) {
    if (!present.has(col)) errors.push(`${col}: listed here but not a free-text column in the schema — remove the stale entry.`);
  }
  return { errors, columns: columns.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const schema = readFileSync(SCHEMA_FILE, 'utf8');
  const source = ERASURE_FILES.map((f) => readFileSync(f, 'utf8')).join('\n');
  const { errors, columns } = check(schema, source);
  if (errors.length) {
    console.error(`check-erasure-coverage: ${errors.length} problem(s)\n`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    console.error('\nSee the COVERAGE block in src/lib/accountErasure.ts and docs/pii-access-lifecycle.md.');
    process.exit(1);
  }
  const erased = [...DECISIONS.values()].filter((v) => v === ERASED).length;
  console.log(`check-erasure-coverage: ${columns} free-text columns, ${erased} erased, ${columns - erased} kept with a reason.`);
}
