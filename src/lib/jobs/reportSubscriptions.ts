// The report-subscription sender (#1905). Hourly: every active subscription
// that is due (src/lib/reportSubscriptions.ts) gets its report — loaded from
// the registry, rendered in the SUBSCRIPTION's language with the tenant's own
// stage labels, behind the same privacy floor as every other surface — and
// one ReportSubscriptionSend row per period.
//
// THE ORDER IS THE GUARANTEE. The period is CLAIMED (a unique insert) before
// anything is read or sent; a second run, a retry or a second replica collides
// on `@@unique([subscriptionId, periodKey])` and sends nothing. A send that
// then fails is recorded FAILED and is not retried in that period: one missed
// report is recoverable, two copies to a funder are not.
//
// Who may receive it is decided at send time as well as at write time: the
// org must still have ADVANCED_ANALYTICS (a file additionally REPORT_EXPORT),
// a user recipient must still be active and not opted out of
// `analytics-report`, an external address must not be on the org's e-mail
// block list. A skip is recorded with its reason, never retried.
//
// node-cron is the carrier only until the leader-elected scheduler (#1676)
// lands; `runReportSubscriptions()` is the handler either way. Registered from
// /api/cron/start, never from initCronJobs, to keep the import graph one-way.

import cron from 'node-cron';
import type { ReportSubscription } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { entitled } from '@/lib/entitlements';
import { settingsOrgOfRow } from '@/lib/settingsOrg';
import { emailGroupAllowedForCategory } from '@/lib/emailGroups';
import { emailDictionary } from '@/i18n/emailDictionary';
import { defaultLocale, isLocale } from '@/i18n/config';
import { getReportDefinition } from '@/lib/reports/definitions';
import { loadReport, ReportUnavailable } from '@/lib/reports/registry';
import { renderReport, reportSheet, toCsv } from '@/lib/reports/render';
import { isCadence, isDue, periodKey, type Cadence } from '@/lib/reportSubscriptions';
import { reportUnsubscribeUrl } from '@/lib/reportSubscriptionTokens';
import { suppressionHash } from '@/lib/postCampaign';
import { emailBrand, recordOptOut, sendEmail } from '@/services/emailService';

export type SendOutcome = 'SENT' | 'SKIPPED' | 'FAILED' | 'DUPLICATE';

export interface SendResult {
  outcome: SendOutcome;
  /** A reason code — never recipient data. */
  reason?: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A recipient other than the subscription's own: the admin asking for a test. */
export interface RecipientOverride {
  userId: string;
}

/**
 * Send one subscription for one period. `periodKey` is the idempotency key —
 * the scheduled run passes the period, a test send passes a unique `test-…`.
 */
export async function sendReportSubscription(
  sub: ReportSubscription,
  opts: { periodKey: string; now?: Date; to?: RecipientOverride },
): Promise<SendResult> {
  const now = opts.now ?? new Date();
  try {
    await prisma.reportSubscriptionSend.create({
      data: { subscriptionId: sub.id, orgId: sub.orgId, periodKey: opts.periodKey, status: 'CLAIMED', sentAt: now },
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') return { outcome: 'DUPLICATE' };
    throw error;
  }
  const finish = async (outcome: Exclude<SendOutcome, 'DUPLICATE'>, reason?: string): Promise<SendResult> => {
    await prisma.reportSubscriptionSend.update({
      where: { subscriptionId_periodKey: { subscriptionId: sub.id, periodKey: opts.periodKey } },
      data: { status: outcome, error: reason ?? null },
    });
    if (outcome === 'SENT' && !opts.to) await prisma.reportSubscription.update({ where: { id: sub.id }, data: { lastSentAt: now } });
    return { outcome, reason };
  };

  try {
    const orgId = sub.orgId;
    const def = getReportDefinition(sub.reportKey);
    if (!orgId || !def) return await finish('SKIPPED', 'unknown_report');
    if (!(await entitled(orgId, 'ADVANCED_ANALYTICS'))) return await finish('SKIPPED', 'locked');
    if (sub.format !== 'EMAIL_SUMMARY' && !(await entitled(orgId, 'REPORT_EXPORT'))) return await finish('SKIPPED', 'export_locked');

    // ── Who receives it ───────────────────────────────────────────────────
    const userId = opts.to?.userId ?? sub.recipientUserId;
    let to: string;
    let name: string | null = sub.recipientName;
    if (userId) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, fullName: true, isActive: true, emailNotifications: true, notificationPrefs: true },
      });
      if (!user || !user.isActive) return await finish('SKIPPED', 'recipient_inactive');
      // People who already opted out of the analytics report stay opted out.
      if (!emailGroupAllowedForCategory(user, 'analytics-report')) {
        // On the delivery log AND in EmailLog, like every honoured opt-out (#2054).
        await recordOptOut(user.email, 'analytics-report', `Scheduled report ${sub.reportKey} (not sent: opted out)`, orgId);
        return await finish('SKIPPED', 'opted_out');
      }
      to = user.email;
      name = user.fullName;
    } else if (sub.recipientEmail) {
      to = sub.recipientEmail.trim().toLowerCase();
      const blocked = await prisma.contactSuppression.findFirst({
        where: { orgId, channel: 'EMAIL', keyHash: suppressionHash(`email:${to}`) },
        select: { id: true },
      });
      if (blocked) return await finish('SKIPPED', 'suppressed');
    } else {
      return await finish('SKIPPED', 'no_recipient');
    }

    // ── What it says ──────────────────────────────────────────────────────
    const locale = isLocale(sub.locale) ? sub.locale : defaultLocale;
    let loaded;
    try {
      loaded = await loadReport(def, { orgId, locale });
    } catch (error) {
      if (error instanceof ReportUnavailable) return await finish('SKIPPED', 'unavailable');
      throw error;
    }
    const t = await emailDictionary(locale, orgId);
    const S = t.reportSubscriptions;
    const view = renderReport(def, loaded, t.reports);
    const brand = await emailBrand(orgId);
    const unsubscribeUrl = reportUnsubscribeUrl(sub.id, brand.appUrl);
    const cadence = isCadence(sub.cadence) ? S.cadence[sub.cadence] : sub.cadence;
    const date = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(now);
    const subject = `${opts.to ? `${S.testPrefix} ` : ''}${S.subject.replace('{report}', view.title).replace('{product}', brand.name)}`;

    const attachments: { filename: string; content: Buffer; contentType: string }[] = [];
    const sheet = reportSheet(view.title, view, loaded);
    const stamp = now.toISOString().slice(0, 10);
    if (sub.format === 'CSV') {
      attachments.push({ filename: `${def.key}-${stamp}.csv`, content: Buffer.from(toCsv(sheet), 'utf8'), contentType: 'text/csv; charset=utf-8' });
    } else if (sub.format === 'XLSX') {
      const XLSX = await import('xlsx');
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([sheet.columns, ...sheet.rows]), sheet.name.slice(0, 31));
      attachments.push({
        filename: `${def.key}-${stamp}.xlsx`,
        content: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
    }

    const cell = 'padding:4px 12px 4px 0;border-bottom:1px solid #eee;';
    const table = view.body.length === 0
      ? `<p>${esc(S.empty)}</p>`
      : `<table style="font-size:14px;border-collapse:collapse;">
          <tr>${view.columns.map((c) => `<th style="${cell}text-align:left;">${esc(c.label)}</th>`).join('')}</tr>
          ${view.body.map((r) => `<tr>${r.map((v) => `<td style="${cell}">${esc(String(v))}</td>`).join('')}</tr>`).join('')}
        </table>`;
    const floor = view.floorNote && loaded.suppressedGroups > 0 ? `<p style="font-size:12px;color:#6b7280;">${esc(view.floorNote)}</p>` : '';
    const html = `<div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto;">
        <h2 style="color:${esc(brand.accent)};">${esc(view.title)}</h2>
        <p>${esc(name ? S.greeting.replace('{name}', name) : S.greetingNoName)}</p>
        <p>${esc(S.intro.replace('{cadence}', cadence).replace('{date}', date))}</p>
        ${sub.format === 'EMAIL_SUMMARY' ? table + floor : `<p>${esc(S.attached.replace('{format}', sub.format))}</p>${floor}`}
        ${userId ? `<p><a href="${esc(brand.appUrl)}/admin/analytics">${esc(S.cta)}</a></p>` : ''}
        <p style="font-size:12px;color:#6b7280;margin-top:24px;">${esc(S.why.replace('{org}', brand.name))}
          <a href="${esc(unsubscribeUrl)}">${esc(S.unsubscribe)}</a></p>
      </div>`;

    const delivery = await sendEmail({
      category: 'analytics-report',
      to,
      subject,
      html,
      locale,
      orgId,
      attachments: attachments.length ? attachments : undefined,
      // A user recipient gets the central opt-out enforcement and footer by
      // passing their id; an external one has none to pass:
      // no-user-row: an external recipient (a dean, a funder) has no account; this subscription's own signed link is their opt-out, in the body and as List-Unsubscribe.
      userId: userId ?? null,
      headers: userId ? undefined : { 'List-Unsubscribe': `<${unsubscribeUrl}>` },
    });
    // Held for approval (#2960): an external recipient of a sales org waits
    // in the outbox; the ledger must not claim it went.
    if (delivery === 'HELD') return await finish('SKIPPED', 'held_for_approval');
    return await finish('SENT');
  } catch (error) {
    logger.error('Report subscription send failed', { subscriptionId: sub.id, error: String(error) });
    return await finish('FAILED', 'send_failed').catch(() => ({ outcome: 'FAILED' as const, reason: 'send_failed' }));
  }
}

export interface RunResult {
  due: number;
  sent: number;
  skipped: number;
  failed: number;
  duplicate: number;
}

// ── The weekly analytics e-mail, as subscriptions (#1905) ───────────────────
//
// `sendWeeklyAnalyticsReport()` mailed every active admin of every org that
// had ADVANCED_ANALYTICS, Mondays at 08:15. It is gone; its readers keep their
// mail as one `pipeline-summary` subscription each (the same figures: totals,
// conversion, the week's activity, every stage), seeded here.
//
// PER ORG, ONCE, AND ONLY WHILE ENTITLED. The claim is a Setting row
// (`LEGACY_SEED_KEY`, unique per org): an org whose first seed already ran is
// never re-seeded, so an admin who deletes their subscription stays
// unsubscribed. An org WITHOUT the tier is not marked — it received nothing
// before — and is seeded on the first pass after it gains the tier, exactly
// when the old job would have started mailing it.
//
// The seeded subscriptions skip the period they are created in (a SKIPPED
// `seeded` row): the deploy that swaps the jobs may land on a Monday after the
// old job already sent, and one missed week is better than a duplicate.
// An admin who joins later subscribes on /admin/reports/subscriptions.
export const LEGACY_SEED_KEY = 'reportSubscriptions.legacyWeeklySeeded';
const LEGACY_REPORT = 'pipeline-summary';

export async function seedLegacyWeeklyReports(opts: { now?: Date; orgIds?: string[] } = {}): Promise<{ orgs: number; subscriptions: number }> {
  const now = opts.now ?? new Date();
  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN', isActive: true },
    select: { id: true, orgId: true, preferredLanguage: true },
  });
  const byOrg = new Map<string, typeof admins>();
  for (const a of admins) {
    const org = await settingsOrgOfRow(a.orgId);
    if (opts.orgIds && !opts.orgIds.includes(org)) continue;
    byOrg.set(org, [...(byOrg.get(org) ?? []), a]);
  }
  const result = { orgs: 0, subscriptions: 0 };
  for (const [orgId, recipients] of byOrg) {
    if (!(await entitled(orgId, 'ADVANCED_ANALYTICS'))) continue;
    if ((await prisma.setting.count({ where: { orgId, key: LEGACY_SEED_KEY } })) > 0) continue;
    try {
      await prisma.setting.create({ data: { orgId, key: LEGACY_SEED_KEY, value: now.toISOString() } });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') continue; // another pass won the claim
      throw error;
    }
    result.orgs++;
    const period = periodKey('WEEKLY', now);
    for (const admin of recipients) {
      const sub = await prisma.reportSubscription.create({
        data: {
          orgId,
          reportKey: LEGACY_REPORT,
          cadence: 'WEEKLY',
          dayOfWeek: 1,
          hour: 8,
          locale: isLocale(admin.preferredLanguage ?? undefined) ? admin.preferredLanguage! : defaultLocale,
          format: 'EMAIL_SUMMARY',
          recipientUserId: admin.id,
        },
      });
      await prisma.reportSubscriptionSend.create({
        data: { subscriptionId: sub.id, orgId, periodKey: period, status: 'SKIPPED', error: 'seeded', sentAt: now },
      });
      result.subscriptions++;
    }
  }
  return result;
}

/** One pass: every active, due subscription (optionally of some orgs only). */
export async function runReportSubscriptions(opts: { now?: Date; orgIds?: string[] } = {}): Promise<RunResult> {
  const now = opts.now ?? new Date();
  await seedLegacyWeeklyReports({ now, orgIds: opts.orgIds });
  const subs = await prisma.reportSubscription.findMany({
    where: { isActive: true, ...(opts.orgIds ? { orgId: { in: opts.orgIds } } : {}) },
    orderBy: { createdAt: 'asc' },
  });
  const result: RunResult = { due: 0, sent: 0, skipped: 0, failed: 0, duplicate: 0 };
  const due = subs.filter((sub) => isCadence(sub.cadence) && isDue(sub, now));
  // A subscription stays due all day, so most hourly passes find its period
  // already done. Read those once instead of letting every one of them hit the
  // unique (the claim below still settles a genuine race).
  const done = new Set(
    due.length === 0
      ? []
      : (await prisma.reportSubscriptionSend.findMany({
          where: { OR: due.map((sub) => ({ subscriptionId: sub.id, periodKey: periodKey(sub.cadence as Cadence, now) })) },
          select: { subscriptionId: true },
        })).map((r) => r.subscriptionId),
  );
  for (const sub of due) {
    result.due++;
    if (done.has(sub.id)) { result.duplicate++; continue; }
    const r = await sendReportSubscription(sub, { periodKey: periodKey(sub.cadence as Cadence, now), now });
    if (r.outcome === 'SENT') result.sent++;
    else if (r.outcome === 'SKIPPED') result.skipped++;
    else if (r.outcome === 'FAILED') result.failed++;
    else result.duplicate++;
  }
  return result;
}

const tasks = new Map<string, cron.ScheduledTask>();

/** Hourly at :25 — off the mail-heavy :00/:15 slots the other jobs use. */
export function initReportSubscriptionsCron() {
  if (tasks.has('report-subscriptions')) return;
  const task = cron.schedule('25 * * * *', async () => {
    try {
      const r = await runReportSubscriptions();
      // A quiet hour is not worth a line; one that did anything is.
      if (r.due > 0) logger.warning('Report subscriptions ran', { ...r });
    } catch (error) {
      logger.error('Report subscriptions cron failed', { error: String(error) });
    }
  });
  tasks.set('report-subscriptions', task);
}
