// E-mail groups: the taxonomy a person actually unsubscribes from (#1290).
//
// The eleven legacy keys in notificationPrefs.ts gate *in-app* notifications and
// were only ever a rough proxy for e-mail. They grew per-feature, not per-kind:
// "mentorship" silenced an offer letter, "digest" silenced a KPI report, and
// nine send sites had no per-user switch at all. Somebody who only wanted the
// automated meeting reminders to stop had to switch off e-mail entirely, which
// also stopped the password reset.
//
// So the e-mail side gets its own vocabulary: twelve groups, each one a kind of
// mail a reasonable person would describe the same way ("stop nagging me about
// my own tasks", "stop the round-up mails", "keep the ones a human wrote me").
// Every mail category in the app belongs to exactly one group, and the group is
// what the footer link, the RFC 8058 one-click header and the settings UI all
// speak in.
//
// This file must stay CLIENT-SAFE: the /u/<token> page and AccountSettings both
// import it. No prisma, no node:crypto, no 'server-only' — the import from
// notificationPrefs is type-only for exactly that reason.
import type { NotificationCategory } from '@/lib/notificationPrefs';

export type EmailGroupId =
  | 'account_security'
  | 'direct_messages'
  | 'mentorship_lifecycle'
  | 'pipeline_updates'
  | 'meeting_invites'
  | 'meeting_reminders'
  | 'task_reminders'
  | 'digests'
  | 'reports_analytics'
  | 'opportunities'
  | 'inbound_requests'
  | 'announcements';

export interface EmailGroupDef {
  id: EmailGroupId;
  /**
   * Transactional mail the account cannot function without. Essential groups
   * ignore every switch (including the master one), carry no unsubscribe
   * footer and no List-* headers: a password reset somebody opted out of is not
   * a preference, it is a lockout.
   */
  essential: boolean;
  /**
   * Automated, non-urgent volume. Rides the SMTP_BULK_* transport and gets
   * `Precedence: bulk` + a `List-Id`, so a reminder blast can never spend the
   * reputation of the domain that carries sign-in mail.
   */
  bulk: boolean;
  /** `sendEmail`'s `category` values that belong to this group. */
  categories: readonly string[];
  /**
   * Legacy in-app keys whose "off" state used to suppress this group's mail.
   * Read only by resolution rule 5 (back-compat), never written.
   */
  legacy: readonly NotificationCategory[];
}

// Order is the display order everywhere: the /u preference centre, the account
// settings section and the API's `groups` array all iterate this array, so the
// user sees the same list in the same order in all three places.
export const EMAIL_GROUPS: readonly EmailGroupDef[] = [
  {
    id: 'account_security',
    essential: true,
    bulk: false,
    categories: [
      'verification', 'password-reset', 'invitation', 'account', 'security',
      'ops-alert', 'test', 'retention-reminder', 'consent',
    ],
    legacy: [],
  },
  {
    id: 'direct_messages',
    essential: false,
    bulk: false,
    categories: ['message', 'mentor-direct'],
    legacy: ['messages'],
  },
  {
    id: 'mentorship_lifecycle',
    essential: false,
    bulk: false,
    categories: [
      'mentorship-request', 'mentorship-decision', 'mentor-assigned',
      'mentee-assigned', 'mentor-application', 'goals-evaluation',
    ],
    legacy: ['mentorship', 'goalsEvaluations'],
  },
  {
    id: 'pipeline_updates',
    essential: false,
    bulk: false,
    categories: ['stage-update', 'offer', 'outcome'],
    legacy: ['stageUpdates'],
  },
  {
    id: 'meeting_invites',
    essential: false,
    bulk: false,
    // 'meeting-guest-invite' is the same invitation addressed to someone with no
    // account here (#1446). It belongs to this group because that is what it is,
    // and classifying it costs nothing: sendMeetingGuestInviteEmail has no
    // recipient User row to pass, so no footer, no List-* header and no
    // preference lookup can fire for it. Leaving it out of the map instead would
    // be the worse choice — an unclassified category is invisible to the
    // taxonomy, and the day someone invites a guest who does turn out to have an
    // account, the mail would silently ship without an opt-out.
    categories: ['meeting-invite', 'meeting-guest-invite', 'meeting-request', 'meeting-request-decision'],
    legacy: [],
  },
  {
    id: 'meeting_reminders',
    essential: false,
    bulk: true,
    // 'meeting-guest-reminder' (#1446) is the account-less sibling of
    // 'meeting-reminder' and is classified with it, which is also what puts it on
    // the bulk relay — its own invitation ('meeting-guest-invite', a non-bulk
    // group) stays on the primary channel, so the mail a guest must actually
    // receive keeps the better reputation while the recurring nudge does not
    // spend it. No header or footer is affected either way: a guest has no User
    // row, so `gated` is false and sendEmail emits none of the List-* markers.
    categories: ['meeting-reminder', 'meeting-guest-reminder', 'meeting-series-reminder'],
    legacy: ['meetingReminders'],
  },
  {
    id: 'task_reminders',
    essential: false,
    bulk: true,
    categories: ['interaction-reminder', 'stage-deadline', 'weekly-report', 'document-reminder'],
    legacy: ['deadlines', 'documents', 'weeklyReports', 'interactions'],
  },
  {
    id: 'digests',
    essential: false,
    bulk: true,
    categories: ['unread-digest', 'activity-digest', 'mentor-digest'],
    legacy: ['digest'],
  },
  {
    id: 'reports_analytics',
    essential: false,
    bulk: true,
    categories: ['analytics-report'],
    legacy: [],
  },
  {
    id: 'opportunities',
    essential: false,
    bulk: true,
    categories: ['company-need-alert'],
    legacy: [],
  },
  {
    id: 'inbound_requests',
    essential: false,
    bulk: false,
    categories: ['public-contact', 'company-inquiry', 'project-join-request', 'mentor-application-received'],
    legacy: [],
  },
  {
    id: 'announcements',
    essential: false,
    bulk: true,
    categories: ['announcement', 're-engagement'],
    legacy: ['announcements'],
  },
];

export const EMAIL_GROUP_IDS: readonly EmailGroupId[] = EMAIL_GROUPS.map((g) => g.id);

/**
 * Group preferences live in the existing `User.notificationPrefs` JSON under
 * flat prefixed keys (`email:digests`), so this feature needs no schema change
 * and no migration. The prefix is what makes that safe: the same blob holds the
 * eleven legacy in-app keys, and a bare `digests` key would have collided with
 * the legacy `digest` family in a way no reader could disambiguate.
 */
export const EMAIL_GROUP_PREF_PREFIX = 'email:';

const BY_ID = new Map<EmailGroupId, EmailGroupDef>(EMAIL_GROUPS.map((g) => [g.id, g]));

// Built once at module load. A category landing in two groups would make
// "which switch turns this mail off?" unanswerable — the one invariant the
// whole feature rests on — so it fails here, at import time, rather than
// silently sending mail the user opted out of.
const BY_CATEGORY = new Map<string, EmailGroupId>();
for (const group of EMAIL_GROUPS) {
  for (const category of group.categories) {
    const existing = BY_CATEGORY.get(category);
    if (existing) {
      throw new Error(
        `emailGroups: category "${category}" is claimed by both "${existing}" and "${group.id}". ` +
          'A category must belong to exactly one group.'
      );
    }
    BY_CATEGORY.set(category, group.id);
  }
}

export function isEmailGroupId(v: unknown): v is EmailGroupId {
  return typeof v === 'string' && BY_ID.has(v as EmailGroupId);
}

export function emailGroupDef(id: EmailGroupId): EmailGroupDef {
  const def = BY_ID.get(id);
  if (!def) throw new Error(`emailGroups: unknown group id "${String(id)}"`);
  return def;
}

/** `null` for a missing or unrecognised category — see the fail-open note below. */
export function groupForCategory(category?: string | null): EmailGroupId | null {
  if (!category) return null;
  return BY_CATEGORY.get(category) ?? null;
}

export function isEssentialGroup(id: EmailGroupId): boolean {
  return emailGroupDef(id).essential;
}

export function isBulkGroup(id: EmailGroupId): boolean {
  return emailGroupDef(id).bulk;
}

export function emailGroupPrefKey(id: EmailGroupId): string {
  return `${EMAIL_GROUP_PREF_PREFIX}${id}`;
}

/** The two `User` columns every gating decision reads. Deliberately narrow so
 *  callers can pass a `select`ed row without widening any query. */
export interface EmailPrefUser {
  emailNotifications?: boolean | null;
  notificationPrefs?: unknown;
}

function prefsOf(user: EmailPrefUser): Record<string, unknown> {
  const raw = user.notificationPrefs;
  // A JSON column can hold anything a past writer put there: null, a string, an
  // array. Only a plain object can carry preferences, and everything else means
  // "no preferences recorded" — never "opted out of everything".
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}

/**
 * May we send this user mail from this group? The six resolution rules, in
 * order — see the block comments inline; each one has a reason that is not
 * obvious from the code.
 */
export function emailGroupAllowed(user: EmailPrefUser, id: EmailGroupId): boolean {
  const def = emailGroupDef(id);

  // RULE 1 — essential mail ignores every switch, including the master one.
  // A password reset the user cannot receive is not a preference, it is a
  // lockout, and it is why these groups never advertise an unsubscribe either.
  if (def.essential) return true;

  // RULE 2 — the master e-mail kill switch still wins over everything below it.
  if (user.emailNotifications === false) return false;

  const prefs = prefsOf(user);

  // RULE 3 / RULE 4 — the new prefixed key, explicit either way. An explicit
  // opt-IN beats a stale legacy opt-out on purpose: the user just told us so in
  // the new UI, and honouring a years-old in-app checkbox over that would look
  // like the switch is broken.
  const v = prefs[emailGroupPrefKey(id)];
  if (v === false) return false;
  if (v === true) return true;

  // RULE 5 — back-compat. Somebody who already opted out of the in-app category
  // that used to suppress this mail stays opted out; this feature must not
  // resubscribe anyone by shipping.
  for (const legacyKey of def.legacy) {
    if (prefs[legacyKey] === false) return false;
  }

  // RULE 6 — default ON. Silence is not consent to stop sending; the mail is
  // part of the product until somebody says otherwise.
  return true;
}

/**
 * Same question, asked with a `sendEmail` category instead of a group id.
 * An uncategorised or unknown category is ALLOWED (fail-open), the same
 * fail-safe reasoning `transportFor` uses: a taxonomy gap must never silently
 * swallow mail somebody is waiting for. A new category that should be gated is
 * added to the table above; until then it behaves exactly as it does today.
 */
export function emailGroupAllowedForCategory(user: EmailPrefUser, category?: string | null): boolean {
  const g = groupForCategory(category);
  return g ? emailGroupAllowed(user, g) : true;
}

/**
 * Every group's current state for a settings UI — the twelve switches as the
 * user should see them.
 *
 * This DELIBERATELY ignores `user.emailNotifications` (rule 2). The master
 * switch is its own visible control right above the list; collapsing it into
 * every group would show somebody who turned e-mail off entirely twelve
 * "off" switches, and the first flip of the master switch would then read back
 * as "they opted out of all twelve" and lose every real choice they had made.
 * Essential groups always resolve `true` — there is nothing to switch.
 */
export function resolveEmailGroupPrefs(user: EmailPrefUser): Record<EmailGroupId, boolean> {
  const out = {} as Record<EmailGroupId, boolean>;
  for (const g of EMAIL_GROUPS) {
    out[g.id] = g.essential
      ? true
      : emailGroupAllowed({ notificationPrefs: user.notificationPrefs }, g.id);
  }
  return out;
}

/**
 * Categories of every group with `bulk: true` — the single source of truth for
 * the SMTP channel split. `emailService.ts` derives its `BULK_CATEGORIES` from
 * this (plus one documented legacy exception) so the transport list and the
 * taxonomy cannot drift apart again.
 */
export const BULK_GROUP_CATEGORIES: readonly string[] = EMAIL_GROUPS
  .filter((g) => g.bulk)
  .flatMap((g) => [...g.categories]);
