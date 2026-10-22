// Survey reminders (#1889): at most two, ever, per invitation.
//
// RULES THIS FILE IS BUILT AROUND (docs/surveys.md § Reminders):
//   • TWO, NEVER THREE. SURVEY_MAX_REMINDERS is the same ceiling the dormant
//     first-contact check-ins live under (src/lib/dormantFirstContact.ts, and
//     CLAUDE.md calls it closed to discussion): two well-timed reminders roughly
//     double a response rate, a third burns the sending domain's reputation.
//   • ONE CLAIM FOR BOTH PATHS. The scheduled pass and the admin's "remind now"
//     both claim reminder k+1 with the same conditional UPDATE
//     (`remindersSent = k AND respondedAt IS NULL`). Exactly one caller can win
//     it, so a click racing the cron sends one mail, and no path reaches three.
//   • NEVER TWICE IN A DAY. A reminder is never sent within MIN_GAP_HOURS of the
//     previous one, whichever path sent it.
//   • ONLY WHILE IT CAN BE ANSWERED. The survey open and in its window, the
//     invitation unanswered and unexpired, the person active and not opted out
//     of the `surveys` e-mail group.
//   • A NEW LINK, THE OLD ONES STILL WORK. Only token hashes are stored, so a
//     reminder mints its own (SurveyInvitationToken); the first mail's link
//     answers the same invitation.
//
// Runs in the same queued job as the campaign sweep (`surveys.campaigns`,
// src/jobs/platform.ts), after the invitations.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { emailGroupAllowed } from '@/lib/emailGroups';
import { settingsOrgOfRow } from '@/lib/settingsOrg';
import { surveyAcceptsAnswers } from '@/lib/surveys';
import { mintInvitationReminderToken, surveyInviteUrl } from '@/lib/surveyTokens';
import { formatDate } from '@/lib/relativeTime';
import { emailDictionary } from '@/i18n/emailDictionary';
import { defaultLocale, isLocale, type Locale } from '@/i18n/config';
import { emailBrand, sendEmail } from '@/services/emailService';
import { dedupeKeyFor } from '@/lib/mailDeliveryRule';

/** The ceiling. Not configurable — see the header. */
export const SURVEY_MAX_REMINDERS = 2;
/** Reminder n (1-based) is due this many days after the invitation went out. */
export const REMINDER_AFTER_DAYS = [3, 7] as const;
export const MIN_GAP_HOURS = 24;
const REMINDER_BATCH = 50;
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export const REMINDER_SELECT = {
  id: true,
  surveyId: true,
  orgId: true,
  email: true,
  locale: true,
  sentAt: true,
  createdAt: true,
  expiresAt: true,
  respondedAt: true,
  remindersSent: true,
  lastRemindedAt: true,
  user: { select: { id: true, fullName: true, isActive: true, orgId: true, preferredLanguage: true, notificationPrefs: true, emailNotifications: true } },
  survey: { select: { id: true, orgId: true, status: true, opensAt: true, closesAt: true } },
} satisfies Prisma.SurveyInvitationSelect;

type ReminderInvitation = Prisma.SurveyInvitationGetPayload<{ select: typeof REMINDER_SELECT }>;

export type ReminderRefusal = 'responded' | 'cap' | 'too_soon' | 'expired' | 'closed' | 'opted_out' | 'lost_race';

/** When the invitation went out — the clock the schedule runs on. */
const invitedAt = (inv: Pick<ReminderInvitation, 'sentAt' | 'createdAt'>) => inv.sentAt ?? inv.createdAt;

/**
 * Why this invitation may not be reminded now, or null when it may. `manual`
 * skips only the schedule (an admin may nudge before day 3) — never the cap,
 * the gap, the window or the opt-out.
 */
export function reminderRefusal(inv: ReminderInvitation, now: Date, manual: boolean): Exclude<ReminderRefusal, 'lost_race'> | 'not_due' | null {
  if (inv.respondedAt) return 'responded';
  if (inv.remindersSent >= SURVEY_MAX_REMINDERS) return 'cap';
  if (inv.expiresAt <= now) return 'expired';
  if (!surveyAcceptsAnswers(inv.survey, now)) return 'closed';
  if (inv.user && (!inv.user.isActive || !emailGroupAllowed(inv.user, 'surveys'))) return 'opted_out';
  if (inv.lastRemindedAt && now.getTime() - inv.lastRemindedAt.getTime() < MIN_GAP_HOURS * HOUR) return 'too_soon';
  if (!manual && now.getTime() < invitedAt(inv).getTime() + REMINDER_AFTER_DAYS[inv.remindersSent] * DAY) return 'not_due';
  return null;
}

/**
 * Claim reminder k+1 and send it. The claim is the conditional UPDATE — a
 * caller that read a stale `remindersSent` (the cron and a click at once)
 * matches nothing and sends nothing.
 */
async function remind(inv: ReminderInvitation, now: Date): Promise<boolean> {
  const claimed = await prisma.surveyInvitation.updateMany({
    where: {
      id: inv.id,
      remindersSent: inv.remindersSent,
      respondedAt: null,
      // The gap is part of the claim too, so two "remind now" clicks a second
      // apart cannot both pass the check above on the same stale read.
      ...(inv.lastRemindedAt ? { lastRemindedAt: inv.lastRemindedAt } : { lastRemindedAt: null }),
    },
    data: { remindersSent: { increment: 1 }, lastRemindedAt: now },
  });
  if (claimed.count !== 1) return false;
  const token = await mintInvitationReminderToken(inv.id);
  await sendReminder(inv, inv.remindersSent + 1, token);
  return true;
}

async function sendReminder(inv: ReminderInvitation, n: number, token: string) {
  const pref = inv.user?.preferredLanguage ?? inv.locale ?? undefined;
  const locale: Locale = isLocale(pref) ? (pref as Locale) : defaultLocale;
  const org = await settingsOrgOfRow(inv.orgId ?? inv.user?.orgId ?? null);
  const t = await emailDictionary(locale, org);
  const brand = await emailBrand(org);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const url = surveyInviteUrl(token, brand.appUrl);
  const body = t.surveyCampaign.reminderBody.replace('{name}', inv.user?.fullName ?? '');
  const expires = t.surveyCampaign.expires.replace('{date}', formatDate(inv.expiresAt, locale));
  const last = n >= SURVEY_MAX_REMINDERS ? `<p>${esc(t.surveyCampaign.lastReminder)}</p>` : '';
  await sendEmail({
    category: 'survey-invite',
    userId: inv.user?.id,
    orgId: inv.orgId ?? inv.user?.orgId ?? null,
    // Reminder n of this invitation, once (#2951), and none after its link expires.
    dedupeKey: dedupeKeyFor({ kind: 'survey', invitationId: inv.id, round: n }),
    notAfter: inv.expiresAt,
    locale,
    to: inv.email,
    subject: t.surveyCampaign.reminderSubject,
    html: `<div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto;">
        ${body.split('\n').map((line) => `<p>${esc(line)}</p>`).join('')}
        <p><a href="${esc(url)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:${esc(brand.accent)};color:#fff;text-decoration:none;">${esc(t.surveyCampaign.cta)}</a></p>
        ${last}
        <p style="font-size:12px;color:#6b7280;">${esc(expires)}</p>
      </div>`,
  }).catch((error) => logger.error('Survey reminder failed', { invitationId: inv.id, error: String(error) }));
}

export interface ReminderSweepResult {
  due: number;
  sent: number;
  deferred: number;
}

/** The scheduled pass: every due reminder, at most REMINDER_BATCH per tick. */
export async function sendDueSurveyReminders(now = new Date(), opts: { orgIds?: string[]; batch?: number } = {}): Promise<ReminderSweepResult> {
  const cap = Math.min(opts.batch ?? REMINDER_BATCH, REMINDER_BATCH);
  const candidates = await prisma.surveyInvitation.findMany({
    where: {
      respondedAt: null,
      remindersSent: { lt: SURVEY_MAX_REMINDERS },
      expiresAt: { gt: now },
      survey: { status: 'OPEN', ...(opts.orgIds ? { orgId: { in: opts.orgIds } } : {}) },
      // The earliest a first reminder can be due; the exact rule is reminderRefusal.
      createdAt: { lte: new Date(now.getTime() - REMINDER_AFTER_DAYS[0] * DAY) },
    },
    orderBy: { createdAt: 'asc' },
    select: REMINDER_SELECT,
  });
  const due = candidates.filter((inv) => reminderRefusal(inv, now, false) === null);
  const result: ReminderSweepResult = { due: due.length, sent: 0, deferred: 0 };
  for (const inv of due) {
    if (result.sent >= cap) {
      result.deferred++;
      continue;
    }
    if (await remind(inv, now)) result.sent++;
  }
  return result;
}

export interface RemindNowResult {
  sent: number;
  /** Over one click's cap: still unreminded, a second click picks them up. */
  deferred: number;
  refused: Partial<Record<ReminderRefusal, number>>;
}

/**
 * "Remind now" from the completion console: the given invitations of one
 * survey, or every unanswered one when `invitationIds` is null. Same claim,
 * same cap, same gap as the schedule — only the day-3/day-7 timing is waived.
 */
export async function remindNow(surveyId: string, invitationIds: string[] | null, now = new Date()): Promise<RemindNowResult> {
  const rows = await prisma.surveyInvitation.findMany({
    where: { surveyId, ...(invitationIds ? { id: { in: invitationIds } } : { respondedAt: null }) },
    select: REMINDER_SELECT,
  });
  const result: RemindNowResult = { sent: 0, deferred: Math.max(0, rows.length - REMINDER_BATCH), refused: {} };
  const refuse = (why: ReminderRefusal) => (result.refused[why] = (result.refused[why] ?? 0) + 1);
  for (const inv of rows.slice(0, REMINDER_BATCH)) {
    const why = reminderRefusal(inv, now, true);
    if (why && why !== 'not_due') {
      refuse(why);
      continue;
    }
    if (await remind(inv, now)) result.sent++;
    else refuse('lost_race');
  }
  return result;
}
