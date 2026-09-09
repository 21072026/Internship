// The notification event catalogue (#1710).
//
// WHY THIS FILE EXISTS
//   Notifications fanned out per feature: each send site picked its own event
//   string, decided on its own whether an e-mail went with the in-app row, and
//   reached for whichever preference helper the author remembered. The event
//   vocabulary itself was only ever written down in one place — the
//   `notifications.events` block of src/i18n/dictionaries.ts — and nothing
//   connected a key there to the category it belongs to, the e-mail group it
//   unsubscribes from, or the channels it should travel on.
//
//   This is that missing half. One entry per event, and the entry is DATA with
//   a type: `notifyEvent()` (src/lib/notifications/router.ts) accepts only a
//   key that appears below, and only a payload carrying every placeholder the
//   dictionary template interpolates. An unknown event, or a payload missing a
//   field, is a compile error rather than a literal `{menteeName}` rendered
//   into somebody's bell.
//
// CLIENT-SAFE, AND DELIBERATELY DEPENDENCY-FREE
//   Every import here is `import type`, so this module has no runtime imports
//   at all. That is not tidiness: it is what lets
//   scripts/test/notification-catalog.test.mjs load the catalogue and the
//   dictionary side by side under plain `node --test` and assert that neither
//   has an entry the other lacks.
//
// WHY NOT A ZOD SCHEMA PER EVENT
//   An event's payload is exactly the set of `{placeholders}` its dictionary
//   template interpolates — and three copies of that already exist (en, tr,
//   de). A hand-written `z.object({ … })` per event would be a FOURTH copy,
//   free to drift from the templates in a way no reader notices until a bell
//   row renders "Stage deadline passed for {menteeName}." The `params` tuple
//   below is the one declaration: the mapped type derives the compile-time
//   payload from it, `validateEventPayload()` is the runtime check, and the
//   unit test pins it against all three locales. A zod schema can still be
//   derived from `params` in one line the day a caller needs one.
//
// NOT A SECOND EVENT VOCABULARY
//   `WEBHOOK_EVENTS` (src/lib/webhooks.ts — seven names) and the versioned
//   domain-event catalogue of #1691 describe what HAPPENED, for consumers
//   outside this app. These keys describe what a PERSON IS TOLD, and they are
//   the keys the dictionary and every existing `Notification.type` row already
//   use. The two map onto each other (a `pipeline.stage_change` domain event is
//   what makes a `stage.changed` notification); neither is derived from the
//   other here, and this file does not fork either.

import type { NotificationCategory } from '@/lib/notificationPrefs';
import type { EmailGroupId } from '@/lib/emailGroups';
import type { LinkKind } from '@/lib/notificationLink';

/** The channels a notification can travel on. One adapter each, in router.ts. */
export const NOTIFICATION_CHANNELS = ['inApp', 'email'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * `immediate` — somebody is waiting for this; send it as it happens.
 * `batched` — automated, non-urgent volume a digest may legitimately roll up.
 * Nothing rolls anything up yet; the field is what a batching worker will read,
 * and declaring it now keeps the decision with the event instead of with
 * whichever cron happens to send it.
 */
export type NotificationDeliveryMode = 'immediate' | 'batched';

/**
 * Id fields `notificationLink()` may consume. Optional on every payload: a
 * missing id degrades to the recipient's role root, which is what that helper
 * already does.
 */
export interface NotificationLinkIds {
  relationId: string;
  menteeId: string;
  projectId: string;
}

export const LINK_ID_KEYS = ['relationId', 'menteeId', 'projectId'] as const;

export interface NotificationEventDef {
  /** Matches a key of `notifications.events` in src/i18n/dictionaries.ts. */
  readonly key: string;
  /** The in-app category switch on /account that silences this event. */
  readonly category: NotificationCategory;
  /**
   * The e-mail group its mail unsubscribes from. An `essential` group makes the
   * event mandatory on EVERY channel — see the MANDATORY note in router.ts.
   */
  readonly emailGroup: EmailGroupId;
  /** Channels used when the caller does not name any. */
  readonly defaultChannels: readonly NotificationChannel[];
  readonly delivery: NotificationDeliveryMode;
  /** Which deep link `notificationLink()` builds for the recipient's role. */
  readonly link: LinkKind;
  /** Placeholder names the dictionary template interpolates, exactly. */
  readonly params: readonly string[];
}

// ── The catalogue ────────────────────────────────────────────────────────────
// One entry per `notifications.events` key. Both directions are asserted by
// scripts/test/notification-catalog.test.mjs: a dictionary key with no entry
// here fails, an entry here with no dictionary key fails, and so does a
// placeholder mismatch — in all three locales.
export const NOTIFICATION_EVENTS = [
  // Mentor nudges and deadlines — cron-driven, batchable, task_reminders mail.
  { key: 'stale_mentee.noContact', category: 'interactions', emailGroup: 'task_reminders', defaultChannels: ['inApp', 'email'], delivery: 'batched', link: 'mentee', params: ['menteeName'] },
  { key: 'deadline.stagePassed', category: 'deadlines', emailGroup: 'task_reminders', defaultChannels: ['inApp', 'email'], delivery: 'batched', link: 'relation', params: ['menteeName'] },
  { key: 'weekly_report_reminder.due', category: 'weeklyReports', emailGroup: 'task_reminders', defaultChannels: ['inApp', 'email'], delivery: 'batched', link: 'dashboard', params: [] },
  { key: 'missing_document.self', category: 'documents', emailGroup: 'task_reminders', defaultChannels: ['inApp', 'email'], delivery: 'batched', link: 'dashboard', params: ['requirement'] },
  { key: 'missing_document.mentor', category: 'documents', emailGroup: 'task_reminders', defaultChannels: ['inApp', 'email'], delivery: 'batched', link: 'relation', params: ['mentee', 'requirement'] },

  // Meetings. An invitation and its answer are meeting_invites; the recurring
  // nudge before a meeting is meeting_reminders — the split a reader actually
  // wants ("stop reminding me", not "stop inviting me").
  { key: 'meeting_reminder.startingSoon', category: 'meetingReminders', emailGroup: 'meeting_reminders', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['title', 'minutes', 'when'] },
  { key: 'meeting_reminder.seriesSoon', category: 'meetingReminders', emailGroup: 'meeting_reminders', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'project', params: ['title', 'project', 'when'] },
  { key: 'meeting_reminder.seriesTomorrow', category: 'meetingReminders', emailGroup: 'meeting_reminders', defaultChannels: ['inApp', 'email'], delivery: 'batched', link: 'project', params: ['title', 'project', 'when'] },
  { key: 'meeting_request.new', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['from'] },
  { key: 'meeting_request.newGeneric', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'meeting_request.declined', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'meeting_request.accepted', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['topic'] },
  { key: 'meeting.started', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['organizer', 'title'] },
  { key: 'meeting.startedGeneric', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['title'] },
  { key: 'meeting.scheduled', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['title', 'when'] },
  { key: 'meeting.scheduledNoTime', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['title'] },
  // An RSVP is the organizer's own bookkeeping: in-app only, no mail per answer.
  { key: 'rsvp.accepted', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['title'] },
  { key: 'rsvp.declined', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['title'] },
  { key: 'guestRsvp.accepted', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['guest', 'title'] },
  { key: 'guestRsvp.declined', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['guest', 'title'] },

  // Conversations: everything one human typed at another.
  { key: 'message.new', category: 'messages', emailGroup: 'direct_messages', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'thread', params: ['from'] },
  { key: 'message.newGeneric', category: 'messages', emailGroup: 'direct_messages', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'thread', params: [] },
  // Already delivered by mail by definition — an e-mail about an e-mail is noise.
  { key: 'message.newByEmail', category: 'messages', emailGroup: 'direct_messages', defaultChannels: ['inApp'], delivery: 'immediate', link: 'thread', params: [] },
  { key: 'question.asked', category: 'messages', emailGroup: 'direct_messages', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'thread', params: ['from'] },
  { key: 'question.askedGeneric', category: 'messages', emailGroup: 'direct_messages', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'thread', params: [] },
  { key: 'question.answered', category: 'messages', emailGroup: 'direct_messages', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'thread', params: [] },
  { key: 'support.new', category: 'messages', emailGroup: 'inbound_requests', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'support', params: ['from'] },
  { key: 'support.newGeneric', category: 'messages', emailGroup: 'inbound_requests', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'support', params: [] },
  { key: 'support.newMessage', category: 'messages', emailGroup: 'inbound_requests', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'support', params: ['from'] },
  { key: 'support.newMessageGeneric', category: 'messages', emailGroup: 'inbound_requests', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'support', params: [] },
  { key: 'support.replied', category: 'messages', emailGroup: 'direct_messages', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'support', params: [] },
  { key: 'support.closed', category: 'messages', emailGroup: 'direct_messages', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'support', params: [] },
  { key: 'public_contact.message', category: 'messages', emailGroup: 'inbound_requests', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['name', 'email', 'preview'] },
  { key: 'signup.companyInquiry', category: 'messages', emailGroup: 'inbound_requests', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['companyName', 'contactName'] },

  // Pipeline: where a candidate stands, and what came of it.
  { key: 'stage.changed', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['from', 'to'] },
  { key: 'outcome.noMatch', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'outcome.placedElsewhere', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  // A prompt to the mentor to write the message themselves — no mail; the point
  // is the draft waiting in the app.
  { key: 'outcome.needsMessage', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp'], delivery: 'immediate', link: 'relation', params: ['name'] },
  { key: 'offer_sent.new', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['position'] },
  { key: 'offer_accepted.admin', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'mentee', params: ['menteeName', 'position'] },
  { key: 'offer_declined.admin', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'mentee', params: ['menteeName', 'position'] },
  { key: 'offer_expired.admin', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'mentee', params: ['menteeName', 'position'] },
  { key: 'company_interest.mentee', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'company_interest.interested', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp'], delivery: 'immediate', link: 'mentee', params: ['company', 'mentee'] },
  { key: 'company_interest.shortlisted', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp'], delivery: 'immediate', link: 'mentee', params: ['company', 'mentee'] },
  { key: 'company_interest.passed', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp'], delivery: 'immediate', link: 'mentee', params: ['company', 'mentee'] },
  { key: 'company_interest.generic', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp'], delivery: 'immediate', link: 'mentee', params: ['mentee'] },

  // The mentorship relationship itself.
  { key: 'mentorship_request.new', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['from'] },
  { key: 'mentorship_request.newGeneric', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'mentorship_request.approved', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'mentorship_request.rejected', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'mentorship_request.mentorAssigned', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['mentorName'] },
  { key: 'mentorship_request.menteeAssigned', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'mentee', params: ['menteeName'] },
  { key: 'mentorship.connected', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'relation', params: ['name'] },
  { key: 'application.received', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['name'] },
  { key: 'interaction.logged', category: 'interactions', emailGroup: 'task_reminders', defaultChannels: ['inApp'], delivery: 'immediate', link: 'relation', params: [] },
  { key: 'interview.assigned', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['name'] },
  { key: 'interview.assignedBlind', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'interview.panelComplete', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'interview_request.approved', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'mentor_application.new', category: 'mentorship', emailGroup: 'inbound_requests', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['name'] },
  { key: 'mentor_application.approved', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'signup.pendingApproval', category: 'mentorship', emailGroup: 'inbound_requests', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['name'] },
  { key: 'signup.new', category: 'mentorship', emailGroup: 'inbound_requests', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['name'] },
  // An operational anomaly rather than news: somebody registered through an
  // invitation that pre-linked a candidate who already has an active mentor,
  // so no mentorship was created and an admin has to decide what should have
  // happened. In-app only, matching what the send site does today (#419) —
  // mailing every admin about a link that did not happen is not the fix.
  { key: 'mentorship.autoLinkSkipped', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['name'] },

  // Re-match (#1801) and the one-step mentor transfer (#2289). Both end one
  // pairing and open another, so every message here is read by somebody whose
  // relation has just changed under them — which is why each one links to the
  // role root rather than to a relation or mentee page: the row the recipient
  // used to have access to is exactly the row that is now closed or reassigned.
  //
  // NEVER THE REASON. `rematchReason`/`rematchNote` and the admin's transfer
  // note carry a candid account of why a pairing did not work, and the outgoing
  // mentor is the person it is about. The templates say the mentorship ended and
  // nothing more; no entry below declares a reason placeholder, and adding one
  // would fail the parity test rather than quietly leak it.
  { key: 'mentorship_request.rematch', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['from'] },
  { key: 'mentorship_request.rematchGeneric', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'mentorship_request.rematchApproved', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'mentorship_request.rematchRejected', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'mentorship_request.rematchMentorNotice', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['menteeName'] },
  { key: 'mentorship.mentorChanged', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['mentorName'] },
  { key: 'mentorship.reassignedAway', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['menteeName'] },
  // In-app ONLY, and that is the send site's deliberate choice rather than an
  // omission: a corrected mis-assignment never was a mentorship, so there is no
  // ending to mail anybody about (src/lib/mentorTransfer.ts). Its sibling
  // `reassignedAway` — a real transfer — does mail, reusing the re-match notice.
  { key: 'mentorship.assignmentCorrected', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['menteeName'] },

  // Goals, evaluations, and the projects they hang off.
  { key: 'goal.assigned', category: 'goalsEvaluations', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'relation', params: ['title'] },
  { key: 'goal.completed', category: 'goalsEvaluations', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'immediate', link: 'relation', params: ['title'] },
  { key: 'evaluation.added', category: 'goalsEvaluations', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'relation', params: [] },
  { key: 'testimonial.approvalRequested', category: 'goalsEvaluations', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'testimonial.declined', category: 'goalsEvaluations', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'project.goalAssigned', category: 'goalsEvaluations', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'project', params: ['title'] },
  { key: 'project.newGoal', category: 'goalsEvaluations', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'immediate', link: 'project', params: ['project', 'title'] },
  { key: 'project.newGoals', category: 'goalsEvaluations', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'batched', link: 'project', params: ['count', 'project'] },
  { key: 'project.newTodo', category: 'goalsEvaluations', emailGroup: 'task_reminders', defaultChannels: ['inApp'], delivery: 'immediate', link: 'project', params: ['title'] },
  { key: 'project.newTodos', category: 'goalsEvaluations', emailGroup: 'task_reminders', defaultChannels: ['inApp'], delivery: 'batched', link: 'project', params: ['count'] },
  { key: 'project.joinRequested', category: 'mentorship', emailGroup: 'inbound_requests', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'project', params: ['from', 'project'] },
  { key: 'project.joinApproved', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'project', params: ['project'] },
  { key: 'project.joinRejected', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'project', params: ['project'] },
  { key: 'project.memberAdded', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'project', params: ['project'] },
  { key: 'weekly_report_review.approved', category: 'weeklyReports', emailGroup: 'task_reminders', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'weekly_report_review.changes', category: 'weeklyReports', emailGroup: 'task_reminders', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: [] },

  // Round-ups and admin-facing counters: in-app only, batchable by nature.
  { key: 'retention.adminSummary', category: 'digest', emailGroup: 'reports_analytics', defaultChannels: ['inApp'], delivery: 'batched', link: 'dashboard', params: ['count'] },
  { key: 're_engagement.adminSummary', category: 'digest', emailGroup: 'reports_analytics', defaultChannels: ['inApp'], delivery: 'batched', link: 'dashboard', params: ['count'] },
  { key: 'duplicate.suspected', category: 'digest', emailGroup: 'digests', defaultChannels: ['inApp'], delivery: 'batched', link: 'dashboard', params: ['name'] },
  { key: 'need_match.newCandidate', category: 'digest', emailGroup: 'opportunities', defaultChannels: ['inApp', 'email'], delivery: 'batched', link: 'dashboard', params: ['candidateName'] },
  { key: 're_engagement.due', category: 'announcements', emailGroup: 'announcements', defaultChannels: ['inApp', 'email'], delivery: 'batched', link: 'dashboard', params: [] },

  // Account and security. Every entry below sits in an `essential` e-mail
  // group, which is what makes it MANDATORY on every channel (see router.ts): a
  // person is told that an administrator entered their account whatever their
  // preferences say, because that is a disclosure, not a notification.
  { key: 'retention.confirm', category: 'deadlines', emailGroup: 'account_security', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'impersonation.accessed', category: 'announcements', emailGroup: 'account_security', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'impersonation.accessedWithReason', category: 'announcements', emailGroup: 'account_security', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['reason'] },
  { key: 'security.passwordResetStarted', category: 'announcements', emailGroup: 'account_security', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'security.adminSignedOutAll', category: 'announcements', emailGroup: 'account_security', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'security.accountUnlocked', category: 'announcements', emailGroup: 'account_security', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  // Somebody got past the second factor without the authenticator (#1542).
  // `immediate` and in an essential group for the same reason as the
  // impersonation rows above: it is a disclosure, not a notification. If the
  // person reading it did not do it, the printed codes are in someone else's
  // hands and every minute counts.
  { key: 'security.recoveryCodeUsed', category: 'announcements', emailGroup: 'account_security', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['remaining'] },
  { key: 'role_changed.toMentor', category: 'announcements', emailGroup: 'account_security', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'role_changed.toMentee', category: 'announcements', emailGroup: 'account_security', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
] as const satisfies readonly NotificationEventDef[];

export type NotificationEventKey = (typeof NOTIFICATION_EVENTS)[number]['key'];

export const NOTIFICATION_EVENT_KEYS: readonly NotificationEventKey[] =
  NOTIFICATION_EVENTS.map((e) => e.key);

type EventFor<K extends NotificationEventKey> = Extract<
  (typeof NOTIFICATION_EVENTS)[number],
  { key: K }
>;

/** The placeholder names this event's dictionary template interpolates. */
export type EventParamName<K extends NotificationEventKey> = EventFor<K>['params'][number];

/**
 * What a caller must hand `notifyEvent()`: every placeholder the template
 * interpolates, plus optionally the ids the deep link is built from. A missing
 * placeholder is a compile error — which is the whole point of the catalogue.
 */
export type EventPayload<K extends NotificationEventKey> = {
  [P in EventParamName<K>]: string | number;
} & Partial<NotificationLinkIds>;

const BY_KEY = new Map<string, NotificationEventDef>(NOTIFICATION_EVENTS.map((e) => [e.key, e]));

// A duplicate key would make "which entry governs this event?" unanswerable and
// would silently shadow one of the two. Fail at import, like emailGroups.ts.
if (BY_KEY.size !== NOTIFICATION_EVENTS.length) {
  const seen = new Set<string>();
  const dupes = NOTIFICATION_EVENTS.map((e) => e.key).filter((k) => {
    if (seen.has(k)) return true;
    seen.add(k);
    return false;
  });
  throw new Error(
    `notifications/catalog: duplicate event key(s): ${[...new Set(dupes)].join(', ')}`
  );
}

export function isNotificationEventKey(v: unknown): v is NotificationEventKey {
  return typeof v === 'string' && BY_KEY.has(v);
}

/** `null` rather than a throw: the router degrades, it never breaks a caller. */
export function eventDef(key: string): NotificationEventDef | null {
  return BY_KEY.get(key) ?? null;
}

/**
 * The runtime half of the payload contract, for values the types cannot see —
 * a payload rebuilt from a JSON job row, or handed in by a JavaScript call
 * site. Returns the placeholder names that are missing or not renderable
 * (`interpolate()` only substitutes strings and numbers).
 */
export function validateEventPayload(
  key: string,
  payload: unknown
): { ok: boolean; missing: string[] } {
  const def = BY_KEY.get(key);
  if (!def) return { ok: false, missing: [] };
  const values =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const missing = def.params.filter((p) => {
    const v = values[p];
    return typeof v !== 'string' && typeof v !== 'number';
  });
  return { ok: missing.length === 0, missing };
}
