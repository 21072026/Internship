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
//   The versioned domain-event catalogue (src/lib/events/catalog.ts, #1691),
//   whose public entries ARE `WEBHOOK_EVENTS`, describes what HAPPENED, for consumers
//   outside this app. These keys describe what a PERSON IS TOLD, and they are
//   the keys the dictionary and every existing `Notification.type` row already
//   use. The two map onto each other (a `pipeline.stage_change` domain event is
//   what makes a `stage.changed` notification); neither is derived from the
//   other here, and this file does not fork either.

import type { NotificationCategory } from '@/lib/notificationPrefs';
import type { EmailGroupId } from '@/lib/emailGroups';
import type { LinkKind } from '@/lib/notificationLink';

/**
 * The channels a notification can travel on. One adapter each, in router.ts.
 * `chat` (#1939, Slack/Teams) is never in an event's `defaultChannels`: the
 * router adds it per recipient, only for a person who confirmed a chat
 * identity — installing an app must not start messaging anybody.
 */
export const NOTIFICATION_CHANNELS = ['inApp', 'email', 'chat', 'push'] as const;
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
  /** A `thread` link to a conversation (`/messages/c/<id>`) rather than a relation's thread. */
  conversationId: string;
}

export const LINK_ID_KEYS = ['relationId', 'menteeId', 'projectId', 'conversationId'] as const;

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

// ── Which events buzz a phone (#1715) ────────────────────────────────────────
// `push` in `defaultChannels` is a deliberate, per-event decision, not a default:
// a push interrupts somebody who closed the app. It goes only to events where
// waiting until the next visit costs the reader something —
//   • a meeting that starts, moved or was called off (they are about to travel
//     or sit in an empty room);
//   • an offer sent or answered, and a stage change of their own record (the
//     moments the whole programme exists for);
//   • the support team's reply (they asked and are waiting);
//   • an interview scheduled or cancelled;
//   • the security notices a person must act on now (a new device, a reused
//     sign-in token, a changed password, every session revoked).
// NEVER pushed: digests, weekly reports, analytics, newsletter issues, nudges,
// announcements' bulk copy and every `batched` event (the deadline and SLA
// reminders among them) — volume a digest may roll up, read when the reader
// chooses; scripts/test/notification-catalog.test.mjs pins that no event
// in a digest, report or newsletter group lists `push`. New messages push too
// (#1464, the channel people expect to interrupt them): their sends pin
// `channels: ['push']` from the message routes and pass the preview; a `thread`
// event collapses per thread in the tray (adapters/push.ts).

// ── The catalogue ────────────────────────────────────────────────────────────
// One entry per `notifications.events` key. Both directions are asserted by
// scripts/test/notification-catalog.test.mjs: a dictionary key with no entry
// here fails, an entry here with no dictionary key fails, and so does a
// placeholder mismatch — in all three locales.
export const NOTIFICATION_EVENTS = [
  // Mentor nudges and deadlines — cron-driven, batchable, task_reminders mail.
  { key: 'stale_mentee.noContact', category: 'interactions', emailGroup: 'task_reminders', defaultChannels: ['inApp', 'email'], delivery: 'batched', link: 'mentee', params: ['menteeName'] },
  { key: 'deadline.stagePassed', category: 'deadlines', emailGroup: 'task_reminders', defaultChannels: ['inApp', 'email'], delivery: 'batched', link: 'relation', params: ['menteeName'] },
  // The escalation ladder's second rung (#1722): the org's administrators, once
  // a breach has stood `escalateAfterDays` without the stage moving. And the
  // all-clear they get when it does move — in-app only, it asks nothing of them.
  { key: 'deadline.slaEscalated', category: 'deadlines', emailGroup: 'task_reminders', defaultChannels: ['inApp', 'email'], delivery: 'batched', link: 'relation', params: ['menteeName', 'mentorName', 'days'] },
  { key: 'deadline.slaResolved', category: 'deadlines', emailGroup: 'task_reminders', defaultChannels: ['inApp'], delivery: 'immediate', link: 'relation', params: ['menteeName'] },
  // The owner's own follow-up date (#2563) — same category, group and job as
  // the stage deadline; a person-written date, not the SLA.
  { key: 'deadline.nextActionDue', category: 'deadlines', emailGroup: 'task_reminders', defaultChannels: ['inApp', 'email'], delivery: 'batched', link: 'relation', params: ['name'] },
  // The trial ladder (#2415, story #2392). Same category and group as the stage
  // deadline above, deliberately: both say "this record needs you before a
  // date", and somebody who muted one meant to mute both — which is why no new
  // category and no new preference key were added for trials.
  { key: 'trial.endingSoon', category: 'deadlines', emailGroup: 'task_reminders', defaultChannels: ['inApp', 'email'], delivery: 'batched', link: 'relation', params: ['company', 'days'] },
  // A won customer's contract ends today (#2841): one bell to the owner, in-app only — the
  // attention queue already carries the notice period every day before it.
  { key: 'contract.endsToday', category: 'deadlines', emailGroup: 'task_reminders', defaultChannels: ['inApp'], delivery: 'immediate', link: 'relation', params: ['company'] },
  // An expired trial's decision window closes in a week (#2843): one bell, in-app.
  { key: 'trial.decisionWindowClosing', category: 'deadlines', emailGroup: 'task_reminders', defaultChannels: ['inApp'], delivery: 'immediate', link: 'relation', params: ['company', 'date'] },
  { key: 'weekly_report_reminder.due', category: 'weeklyReports', emailGroup: 'task_reminders', defaultChannels: ['inApp', 'email'], delivery: 'batched', link: 'dashboard', params: [] },
  // The document review chain (#1859): the owner hears the verdict and the expiry, the programme hears the expiry.
  { key: 'document.approved', category: 'documents', emailGroup: 'task_reminders', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['requirement'] },
  { key: 'document.rejected', category: 'documents', emailGroup: 'task_reminders', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['requirement', 'reason'] },
  { key: 'document.expired', category: 'documents', emailGroup: 'task_reminders', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['requirement'] },
  { key: 'document.expired.admin', category: 'documents', emailGroup: 'task_reminders', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['owner', 'requirement'] },
  { key: 'missing_document.self', category: 'documents', emailGroup: 'task_reminders', defaultChannels: ['inApp', 'email'], delivery: 'batched', link: 'dashboard', params: ['requirement'] },
  { key: 'missing_document.mentor', category: 'documents', emailGroup: 'task_reminders', defaultChannels: ['inApp', 'email'], delivery: 'batched', link: 'relation', params: ['mentee', 'requirement'] },

  // Meetings. An invitation and its answer are meeting_invites; the recurring
  // nudge before a meeting is meeting_reminders — the split a reader actually
  // wants ("stop reminding me", not "stop inviting me").
  // The one neutral note to someone marked absent (#2014) — in-app only, no
  // score, sent once per record (MeetingAttendance.noShowNotifiedAt).
  { key: 'meeting.noShow', category: 'meetingReminders', emailGroup: 'meeting_reminders', defaultChannels: ['inApp'], delivery: 'immediate', link: 'relation', params: [] },
  // Group sessions (#1856): the publish notice to the audience, a waitlist
  // promotion, a call-off and a move. In-app only — a seat change is a bell line.
  { key: 'event.published', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['title', 'when'] },
  { key: 'event.promoted', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['title', 'when'] },
  { key: 'event.cancelled', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['title', 'when'] },
  { key: 'event.updated', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['title', 'when'] },
  // Meeting invite, reminder, move and call-off reach chat too (#1942): the
  // card carries the join link as a button and a move/cancel REWRITES the
  // earlier card (ChatCard.supersede). The mail for all of them is sent inline
  // by its own sender, so `email` is deliberately not a default channel here —
  // the router would otherwise send a second, generic mail.
  { key: 'meeting_reminder.startingSoon', category: 'meetingReminders', emailGroup: 'meeting_reminders', defaultChannels: ['inApp', 'chat', 'push'], delivery: 'immediate', link: 'dashboard', params: ['title', 'minutes', 'when'] },
  { key: 'meeting_reminder.seriesSoon', category: 'meetingReminders', emailGroup: 'meeting_reminders', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'project', params: ['title', 'project', 'when'] },
  { key: 'meeting_reminder.seriesTomorrow', category: 'meetingReminders', emailGroup: 'meeting_reminders', defaultChannels: ['inApp', 'email'], delivery: 'batched', link: 'project', params: ['title', 'project', 'when'] },
  { key: 'meeting_request.new', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['from'] },
  { key: 'meeting_request.newGeneric', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'meeting_request.declined', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'meeting_request.accepted', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['topic'] },
  { key: 'meeting.started', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp', 'email', 'push'], delivery: 'immediate', link: 'dashboard', params: ['organizer', 'title'] },
  { key: 'meeting.startedGeneric', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp', 'email', 'push'], delivery: 'immediate', link: 'dashboard', params: ['title'] },
  { key: 'meeting.scheduled', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp', 'chat'], delivery: 'immediate', link: 'dashboard', params: ['title', 'when'] },
  { key: 'meeting.scheduledNoTime', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp', 'chat'], delivery: 'immediate', link: 'dashboard', params: ['title'] },
  // A meeting that moved or was called off (#1982) — the mail is sent inline by
  // src/lib/meetingChangeNotices.ts, so the router is asked for in-app only.
  { key: 'meeting.rescheduled', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp', 'chat', 'push'], delivery: 'immediate', link: 'dashboard', params: ['title', 'from', 'to'] },
  { key: 'meeting.cancelled', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp', 'chat', 'push'], delivery: 'immediate', link: 'dashboard', params: ['title', 'when'] },
  { key: 'meeting.cancelledReason', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp', 'chat', 'push'], delivery: 'immediate', link: 'dashboard', params: ['title', 'when', 'reason'] },
  // An RSVP is the organizer's own bookkeeping: in-app only, no mail per answer.
  { key: 'rsvp.accepted', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['title'] },
  { key: 'rsvp.declined', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['title'] },
  // A decline that suggested another time (#1982); the counter sits in the organiser's requests list.
  { key: 'rsvp.counterProposed', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['title', 'when'] },
  { key: 'guestRsvp.accepted', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['guest', 'title'] },
  { key: 'guestRsvp.declined', category: 'meetingReminders', emailGroup: 'meeting_invites', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['guest', 'title'] },

  // Conversations: everything one human typed at another.
  { key: 'message.new', category: 'messages', emailGroup: 'direct_messages', defaultChannels: ['inApp', 'email', 'push'], delivery: 'immediate', link: 'thread', params: ['from'] },
  { key: 'message.newGeneric', category: 'messages', emailGroup: 'direct_messages', defaultChannels: ['inApp', 'email', 'push'], delivery: 'immediate', link: 'thread', params: [] },
  // Already delivered by mail by definition — an e-mail about an e-mail is noise.
  { key: 'message.newByEmail', category: 'messages', emailGroup: 'direct_messages', defaultChannels: ['inApp', 'push'], delivery: 'immediate', link: 'thread', params: [] },
  { key: 'question.asked', category: 'messages', emailGroup: 'direct_messages', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'thread', params: ['from'] },
  { key: 'question.askedGeneric', category: 'messages', emailGroup: 'direct_messages', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'thread', params: [] },
  { key: 'question.answered', category: 'messages', emailGroup: 'direct_messages', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'thread', params: [] },
  { key: 'support.new', category: 'messages', emailGroup: 'inbound_requests', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'support', params: ['from'] },
  { key: 'support.newGeneric', category: 'messages', emailGroup: 'inbound_requests', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'support', params: [] },
  { key: 'support.newMessage', category: 'messages', emailGroup: 'inbound_requests', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'support', params: ['from'] },
  { key: 'support.newMessageGeneric', category: 'messages', emailGroup: 'inbound_requests', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'support', params: [] },
  { key: 'support.replied', category: 'messages', emailGroup: 'direct_messages', defaultChannels: ['inApp', 'email', 'push'], delivery: 'immediate', link: 'support', params: [] },
  { key: 'support.closed', category: 'messages', emailGroup: 'direct_messages', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'support', params: [] },
  // Safeguarding (#2056): to the org's admins only, in-app only, no params — the
  // bell never says who wrote what; the queue behind its own route check does.
  { key: 'safeguarding.flagged', category: 'messages', emailGroup: 'inbound_requests', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'public_contact.message', category: 'messages', emailGroup: 'inbound_requests', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['name', 'email', 'preview'] },
  { key: 'signup.companyInquiry', category: 'messages', emailGroup: 'inbound_requests', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['companyName', 'contactName'] },
  // An employer signed itself up and waits, PENDING, for an admin (#1865).
  { key: 'signup.companySelf', category: 'messages', emailGroup: 'inbound_requests', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['companyName', 'domain'] },
  // New leads a pull connector imported in one run (docs/integrations/klaviyo.md):
  // to the lead owner, in-app only, a count — never a name.
  { key: 'integration.newLeads', category: 'messages', emailGroup: 'inbound_requests', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['count', 'provider'] },

  // Pipeline: where a candidate stands, and what came of it.
  // Stage automation (#1703): an admin's rule told the relation's own people.
  // In-app only — the rule's mail action is a separate, catalogued template.
  { key: 'automation.stageReached', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp'], delivery: 'immediate', link: 'relation', params: ['name', 'stage'] },
  { key: 'automation.stageReachedSelf', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['stage'] },
  { key: 'automation.documentRequired', category: 'documents', emailGroup: 'task_reminders', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['document'] },
  // An admin-authored nudge (#1684). In-app copy of the rule's own text; the
  // mail is the evaluator's, sent through the one mail door under 'nudge'.
  { key: 'nudge.message', category: 'interactions', emailGroup: 'task_reminders', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['text'] },
  { key: 'stage.changed', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp', 'email', 'push'], delivery: 'immediate', link: 'dashboard', params: ['from', 'to'] },
  { key: 'outcome.noMatch', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'outcome.placedElsewhere', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  // A prompt to the mentor to write the message themselves — no mail; the point
  // is the draft waiting in the app.
  { key: 'outcome.needsMessage', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp'], delivery: 'immediate', link: 'relation', params: ['name'] },
  { key: 'offer_sent.new', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp', 'email', 'push'], delivery: 'immediate', link: 'dashboard', params: ['position'] },
  { key: 'offer_accepted.admin', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp', 'email', 'push'], delivery: 'immediate', link: 'mentee', params: ['menteeName', 'position'] },
  { key: 'offer_declined.admin', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp', 'email', 'push'], delivery: 'immediate', link: 'mentee', params: ['menteeName', 'position'] },
  // A mentee applied through the job board (#1832): the company's users and the mentee's mentor hear it.
  { key: 'job_application.received', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['candidate', 'role'] },
  { key: 'job_application.mentee_applied', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp'], delivery: 'immediate', link: 'mentee', params: ['candidate', 'role'] },
  { key: 'offer_expired.admin', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'mentee', params: ['menteeName', 'position'] },
  { key: 'company_interest.mentee', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'company_interest.interested', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp'], delivery: 'immediate', link: 'mentee', params: ['company', 'mentee'] },
  { key: 'company_interest.shortlisted', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp'], delivery: 'immediate', link: 'mentee', params: ['company', 'mentee'] },
  { key: 'company_interest.passed', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp'], delivery: 'immediate', link: 'mentee', params: ['company', 'mentee'] },
  { key: 'company_interest.generic', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp'], delivery: 'immediate', link: 'mentee', params: ['mentee'] },
  // Company → candidate message requests (#1840): in-app only — a mentor's
  // queue, the candidate's new channel, and the company's answer (never why).
  { key: 'outreach.requested', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['company', 'name'] },
  { key: 'outreach.approvedCandidate', category: 'messages', emailGroup: 'inbound_requests', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['company'] },
  { key: 'outreach.approvedCompany', category: 'messages', emailGroup: 'inbound_requests', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['name'] },
  { key: 'outreach.declinedCompany', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['name'] },
  { key: 'outreach.revokedCompany', category: 'messages', emailGroup: 'inbound_requests', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['name'] },

  // Employer verification (#1865): the admin's decision, told to the company's
  // users in-app and by mail — with the reason on a refusal, because
  // "rejected" without one is not actionable.
  { key: 'company.verification.approved', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['company'] },
  { key: 'company.verification.rejected', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['company', 'reason'] },
  { key: 'company.verification.suspended', category: 'stageUpdates', emailGroup: 'pipeline_updates', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['company', 'reason'] },

  // The mentorship relationship itself.
  { key: 'mentorship_request.new', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['from'] },
  { key: 'mentorship_request.newGeneric', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'mentorship_request.approved', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'mentorship_request.rejected', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  // Request expiry (#1775, src/lib/requestExpiry.ts): ONE nudge to whoever holds
  // the request on day 7, the mentee told on expiry, and an admin's cancellation
  // with its reason. In-app, like every other step of the request lifecycle.
  { key: 'mentorship_request.nudge', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['from'] },
  { key: 'mentorship_request.expired', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'mentorship_request.cancelled', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['reason'] },
  { key: 'mentorship_request.mentorAssigned', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['mentorName'] },
  { key: 'mentorship_request.menteeAssigned', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'mentee', params: ['menteeName'] },
  // Mentor Offers (#1809). The mentee's two (the offer, the one reminder) are
  // sent by src/lib/mentorOffers.ts only to someone who opted in; their mail
  // goes inline under the 'mentor-offer' category, so these entries are in-app.
  { key: 'mentor_offer.new', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['mentorName'] },
  { key: 'mentor_offer.reminder', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['mentorName'] },
  { key: 'mentor_offer.accepted', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['menteeName'] },
  { key: 'mentor_offer.declined', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['menteeName'] },
  // The agreed end of a pairing (#1786, src/lib/relationEndingSweep.ts): ONE
  // ending-soon notice per end date to both sides, and the extension. The
  // ending-soon mail goes inline under the 'relation-ending' category.
  { key: 'mentorship.ending_soon', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['name', 'date'] },
  { key: 'mentorship.extended', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['name', 'date'] },
  { key: 'mentorship.connected', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'relation', params: ['name'] },
  { key: 'application.received', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['name'] },
  { key: 'interaction.logged', category: 'interactions', emailGroup: 'task_reminders', defaultChannels: ['inApp'], delivery: 'immediate', link: 'relation', params: [] },
  { key: 'interview.assigned', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['name'] },
  { key: 'interview.assignedBlind', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'interview.panelComplete', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: [] },
  // The outcome of a closed panel, told to the company — the decision only, never a score (#1846).
  { key: 'interview_panel.outcome.advance', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['title'] },
  { key: 'interview_panel.outcome.offer', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['title'] },
  { key: 'interview_panel.outcome.reject', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['title'] },
  { key: 'interview_request.approved', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'interview_request.declined', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['reasonCode'] },
  // The confirmed interview time, on the recipient's own clock (#1844); the cancellation of it.
  { key: 'interview_request.scheduled', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email', 'push'], delivery: 'immediate', link: 'dashboard', params: ['title', 'when'] },
  { key: 'interview_request.cancelled', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email', 'push'], delivery: 'immediate', link: 'dashboard', params: ['title'] },
  { key: 'affiliate_application.new', category: 'messages', emailGroup: 'inbound_requests', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['name'] },
  { key: 'mentor_application.new', category: 'mentorship', emailGroup: 'inbound_requests', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['name'] },
  { key: 'mentor_application.approved', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  // Plan-change requests (#1743): to the operators of the org's world, and the
  // answer back to the requesting admin. In-app only — the operator queue and
  // the billing screen are where the request lives.
  { key: 'plan_change.requested', category: 'announcements', emailGroup: 'inbound_requests', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['org', 'plan'] },
  { key: 'plan_change.applied', category: 'announcements', emailGroup: 'announcements', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['plan'] },
  { key: 'plan_change.rejected', category: 'announcements', emailGroup: 'announcements', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['plan'] },
  // A public application held at the plan's active-pair cap (#1745): the
  // applicant is told only that the programme is full, the org's admins are
  // told why. In-app only, at most one a day per admin (src/app/api/apply).
  { key: 'plan_limit.application_held', category: 'announcements', emailGroup: 'inbound_requests', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['limit'] },
  // The same for a project a mentee could not create at the project cap (#3270).
  { key: 'plan_limit.project_held', category: 'announcements', emailGroup: 'inbound_requests', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['limit'] },
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
  // A pairing paused, resumed, ended or reopened through the lifecycle endpoint
  // (#1770). In-app only: the send site notifies the pair with `notify()` and
  // mails nobody. `name` is the OTHER participant; the reason is never a param.
  { key: 'relation.lifecycle_paused', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['name'] },
  { key: 'relation.lifecycle_resumed', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['name'] },
  { key: 'relation.lifecycle_ended', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['name'] },
  { key: 'relation.lifecycle_reopened', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['name'] },
  // In-app ONLY, and that is the send site's deliberate choice rather than an
  // omission: a corrected mis-assignment never was a mentorship, so there is no
  // ending to mail anybody about (src/lib/mentorTransfer.ts). Its sibling
  // `reassignedAway` — a real transfer — does mail, reusing the re-match notice.
  { key: 'mentorship.assignmentCorrected', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: ['menteeName'] },
  // The batch shape of the two rows above (#2439, POST /api/admin/candidates/bulk).
  // A portfolio hand-over names ONE incoming mentor on up to 200 rows and
  // usually drains one outgoing mentor, so the per-row notices would reach the
  // same person 200 times — the storm the sibling advanceStage branch keeps a
  // `notifiedMentees` set to prevent. The bulk caller suppresses them and sends
  // exactly one of these per mentor, carrying the count instead of a name.
  // In-app ONLY, and deliberately: the whole point is that the mailbox does not
  // receive the batch (the per-row e-mail is suppressed with the notice).
  { key: 'mentorship.bulkAssigned', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'batched', link: 'dashboard', params: ['count'] },
  { key: 'mentorship.bulkReassignedAway', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'batched', link: 'dashboard', params: ['count'] },

  // Goals, evaluations, and the projects they hang off.
  { key: 'goal.assigned', category: 'goalsEvaluations', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'relation', params: ['title'] },
  { key: 'goal.completed', category: 'goalsEvaluations', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'immediate', link: 'relation', params: ['title'] },
  { key: 'evaluation.added', category: 'goalsEvaluations', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'relation', params: [] },
  // Evaluation due reminders to the mentor (#1891): at most two per evaluation;
  // the mail goes in the existing `goals-evaluation` category (src/lib/evaluationDue.ts).
  { key: 'evaluation.dueInterim', category: 'goalsEvaluations', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'relation', params: ['menteeName'] },
  { key: 'evaluation.dueFinal', category: 'goalsEvaluations', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'relation', params: ['menteeName'] },
  // The kickoff prompt to read the mentoring agreement (#1792) — in-app, a prompt not a gate.
  { key: 'agreement.review', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'immediate', link: 'relation', params: [] },
  // Program journey steps (#1852): in-app only — the daily sweep delivers each
  // step to the pair once, under the recipient's `mentorship` preference
  // (src/lib/programJourney.ts). No mail: #1703's automation engine owns that.
  { key: 'programStep.nudge', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'batched', link: 'relation', params: ['title'] },
  { key: 'programStep.todo', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'batched', link: 'relation', params: ['title'] },
  { key: 'programStep.content', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'batched', link: 'relation', params: ['title'] },
  { key: 'programStep.agenda', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'batched', link: 'relation', params: ['title'] },
  { key: 'programStep.groupSession', category: 'mentorship', emailGroup: 'mentorship_lifecycle', defaultChannels: ['inApp'], delivery: 'batched', link: 'relation', params: ['title'] },
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
  // An admin cleared somebody's second factor (#1543). It carries `admin`
  // because the owner's question is not "did this happen" but "who did it" —
  // an insider reset the owner cannot name is one they cannot dispute.
  { key: 'security.twoFactorReset', category: 'announcements', emailGroup: 'account_security', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['admin'] },
  // Enforced SSO's break-glass exemption (#1950). A disclosure like the rest of
  // this block: the holder is the tenant's password back door, and an exemption
  // its holder never heard about is the kind that is still there a year later.
  { key: 'security.ssoExemptGranted', category: 'announcements', emailGroup: 'account_security', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'security.ssoExemptRevoked', category: 'announcements', emailGroup: 'account_security', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  // Somebody got past the second factor without the authenticator (#1542).
  // `immediate` and in an essential group for the same reason as the
  // impersonation rows above: it is a disclosure, not a notification. If the
  // person reading it did not do it, the printed codes are in someone else's
  // hands and every minute counts.
  { key: 'security.recoveryCodeUsed', category: 'announcements', emailGroup: 'account_security', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['remaining'] },
  // Security notices (#1717) — src/lib/securityNotices.ts is their one sender.
  // Each is a disclosure like the rows above: the reader may be the victim, so
  // the mail goes through the essential group whatever the preferences say.
  // `newDevice` is a sign-in from a browser the account has not used before
  // (rule in signInDeviceRule.ts); `deviceTokenReuse` a replayed remember-me
  // cookie (trustedDevice.ts). `sessionsRevoked` is the owner's own "sign out
  // of all devices"; the admin-pressed one is `adminSignedOutAll` above.
  { key: 'security.newDevice', category: 'announcements', emailGroup: 'account_security', defaultChannels: ['inApp', 'email', 'push'], delivery: 'immediate', link: 'dashboard', params: ['device'] },
  { key: 'security.deviceTokenReuse', category: 'announcements', emailGroup: 'account_security', defaultChannels: ['inApp', 'email', 'push'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'security.passwordChanged', category: 'announcements', emailGroup: 'account_security', defaultChannels: ['inApp', 'email', 'push'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'security.emailChanged', category: 'announcements', emailGroup: 'account_security', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: ['email'] },
  { key: 'security.twoFactorEnabled', category: 'announcements', emailGroup: 'account_security', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'security.twoFactorDisabled', category: 'announcements', emailGroup: 'account_security', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'security.recoveryCodesRegenerated', category: 'announcements', emailGroup: 'account_security', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'security.payoutDetailsChanged', category: 'announcements', emailGroup: 'account_security', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'security.sessionsRevoked', category: 'announcements', emailGroup: 'account_security', defaultChannels: ['inApp', 'email', 'push'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'role_changed.toMentor', category: 'announcements', emailGroup: 'account_security', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  { key: 'role_changed.toMentee', category: 'announcements', emailGroup: 'account_security', defaultChannels: ['inApp', 'email'], delivery: 'immediate', link: 'dashboard', params: [] },
  // An admin tier change (#1579) signs the person out everywhere; this tells
  // them why when they are back. No params: the new tier is on their screen.
  { key: 'admin_tier.changed', category: 'announcements', emailGroup: 'account_security', defaultChannels: ['inApp'], delivery: 'immediate', link: 'dashboard', params: [] },
  // Account mails (#3399): invitation, password reset and e-mail verification.
  // They are NEVER published through notifyEvent() — each has its own sender in
  // emailService.ts, because the mail carries a one-time token. They are here
  // so the template editor can change their wording; the token link itself is
  // drawn by renderNotificationEmail() and is not a merge tag.
  { key: 'account.invitation', category: 'announcements', emailGroup: 'account_security', defaultChannels: ['email'], delivery: 'immediate', link: 'dashboard', params: ['role'] },
  { key: 'account.passwordReset', category: 'announcements', emailGroup: 'account_security', defaultChannels: ['email'], delivery: 'immediate', link: 'dashboard', params: ['name'] },
  { key: 'account.verification', category: 'announcements', emailGroup: 'account_security', defaultChannels: ['email'], delivery: 'immediate', link: 'dashboard', params: ['name'] },
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
