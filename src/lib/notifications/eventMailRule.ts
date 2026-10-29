// Which mail category an event mail goes out under (#1719). Pure, so the unit
// spec can hold it against the e-mail group taxonomy without the mail stack.

import type { EmailGroupId } from '@/lib/emailGroups';

/**
 * The mail category an event mail is sent under, per e-mail group. A category
 * decides the lane, the outbound-approval rule and the delivery log bucket, so
 * it must be a category that already belongs to the group (the unit spec
 * asserts groupForCategory(EVENT_MAIL_CATEGORY[g]) === g for every group).
 */
export const EVENT_MAIL_CATEGORY: Record<EmailGroupId, string> = {
  account_security: 'security',
  direct_messages: 'message',
  mentorship_lifecycle: 'mentorship-decision',
  pipeline_updates: 'stage-update',
  meeting_invites: 'meeting-invite',
  meeting_reminders: 'meeting-reminder',
  task_reminders: 'nudge',
  digests: 'activity-digest',
  reports_analytics: 'analytics-report',
  opportunities: 'company-need-alert',
  inbound_requests: 'support-report',
  newsletter: 'newsletter',
  surveys: 'survey-invite',
  announcements: 'announcement',
};
