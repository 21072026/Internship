import cron from 'node-cron';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { logActivity } from '@/lib/activity';
import { emailAllowed } from '@/lib/notificationPrefs';
import { getOrgBranding } from '@/lib/orgBranding';
import { getSetting } from '@/lib/settings';
import { getDictionary } from '@/i18n/dictionaries';
import { defaultLocale, type Locale } from '@/i18n/config';
import { sendEmail } from '@/services/emailService';
import { renderNewsletterHtml, type NewsletterEmailLabels } from '@/lib/newsletterEmail';
import { nextUnusedTemplate } from '@/lib/newsletterContent';
import {
  newsletterArchiveUrl,
  newsletterPreferencesUrl,
  newsletterUnsubscribeUrl,
} from '@/lib/newsletterTokens';
import {
  NEWSLETTER_EMAIL_CATEGORY,
  audienceRoles,
  canonicalNewsletterContent,
  normalizeNewsletterContent,
  resolveNewsletterContent,
  resolveNewsletterLocale,
  showsMentorNote,
  type NewsletterAudience,
  type NewsletterIssueContent,
  type NewsletterVariants,
} from '@/lib/newsletter';

/**
 * Sending a newsletter issue, and the schedule that does it unattended (#1469).
 *
 * ── WHY THIS IS NOT IN emailService.ts ─────────────────────────────────────
 * emailService owns the transport (two SMTP channels, the delivery log, the
 * health alerts). This file is a *consumer* of it. Keeping the dependency
 * one-way means the newsletter can import `sendEmail` without emailService
 * importing anything back — no import cycle, and the cron here is registered
 * next to the others from `/api/cron/start` rather than from inside
 * `initCronJobs`.
 *
 * ── WHY A PER-RECIPIENT ROW ────────────────────────────────────────────────
 * `NewsletterSend` is written before the counters are updated and is unique per
 * (issue, address). That single constraint buys three things at once:
 *
 *   1. A dispatch run that dies half-way can simply be re-run — everyone
 *      already mailed is skipped, nobody gets the issue twice.
 *   2. The sent history survives EmailLog's 90-day pruning, so "which issues
 *      has this person been sent?" stays answerable.
 *   3. Two overlapping runs (a cron tick and an admin pressing Send) cannot
 *      double-mail, even though the status claim below is not a distributed
 *      lock.
 */

// How many messages are in flight at once. Deliberately small: this rides the
// bulk SMTP channel, and opening 500 concurrent connections to it is how a
// send gets the whole server rate-limited. Sequential would be safest but a
// 500-recipient issue would then take minutes of wall clock inside one cron
// tick.
const SEND_CONCURRENCY = 4;

export interface NewsletterDispatchResult {
  newsletterId: string;
  /** Recipients considered — i.e. active users in the audience with an address. */
  recipients: number;
  sent: number;
  failed: number;
  skipped: number;
  /** True when the issue was already sent, canceled, or still a draft. */
  noop?: boolean;
  reason?: string;
}

/** The mail chrome for one recipient's language. */
function labelsFor(locale: Locale): NewsletterEmailLabels {
  const n = getDictionary(locale).newsletter;
  return {
    kicker: n.emailKicker,
    actionTitle: n.emailActionTitle,
    mentorTitle: n.emailMentorTitle,
    footerWhy: n.emailFooterWhy,
    archiveLink: n.emailArchiveLink,
    preferencesLink: n.emailPreferencesLink,
    unsubscribeLink: n.emailUnsubscribeLink,
  };
}

export const NEWSLETTER_IMAGE_CID = 'newsletter-hero';
const IMAGE_CID = NEWSLETTER_IMAGE_CID;

/** Derived from the allow-listed MIME type, never from the uploaded filename. */
export function newsletterImageFilename(contentType: string): string {
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[contentType] ?? 'img';
  return `newsletter.${ext}`;
}

interface Recipient {
  id: string;
  email: string;
  role: string;
  preferredLanguage: string | null;
  emailNotifications: boolean | null;
  notificationPrefs: Prisma.JsonValue;
}

/**
 * Render one recipient's copy. Exported because the admin preview and the test
 * send have to show *exactly* what a real recipient would get — a preview built
 * by a second code path is a preview of nothing.
 */
export async function renderNewsletterFor(options: {
  variants: NewsletterVariants;
  canonical: NewsletterIssueContent;
  audience: NewsletterAudience;
  role: string;
  preferredLanguage: string | null | undefined;
  /** `cid:` for a real send, a browser-loadable URL for the preview, null for neither. */
  imageSrc?: string | null;
  /** Omitted for the preview: there is no subscription to cancel from there. */
  userId?: string | null;
}): Promise<{ subject: string; html: string; locale: Locale }> {
  const { variants, canonical, audience, role, preferredLanguage, imageSrc, userId } = options;
  const locale = resolveNewsletterLocale(variants, preferredLanguage);
  const content = resolveNewsletterContent(variants, canonical, preferredLanguage);
  const brand = await getOrgBranding(null);

  return {
    subject: content.subject,
    locale,
    html: renderNewsletterHtml({
      content,
      // A tenant that set no brand colour yields null here; the renderer's
      // accentOf() turns anything that is not a hex value into the product blue.
      brand: { name: brand.name, accent: brand.color ?? '', logoUrl: brand.logoUrl },
      labels: labelsFor(locale),
      withMentorNote: showsMentorNote(audience, role),
      imageSrc: imageSrc ?? null,
      archiveUrl: newsletterArchiveUrl(),
      preferencesUrl: newsletterPreferencesUrl(),
      unsubscribeUrl: userId ? newsletterUnsubscribeUrl(userId) : null,
    }),
  };
}

/** Run `task` over `items` with a small fixed concurrency, in order. */
async function pooled<T>(items: T[], task: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += SEND_CONCURRENCY) {
    await Promise.all(items.slice(i, i + SEND_CONCURRENCY).map(task));
  }
}

/**
 * Send one issue.
 *
 * Accepts SCHEDULED (the normal path, from the cron or from "send now") and
 * SENDING (resuming a run that died). A DRAFT is refused: the whole point of the
 * draft state is that the scheduler cannot touch it.
 */
export async function dispatchNewsletter(newsletterId: string): Promise<NewsletterDispatchResult> {
  const issue = await prisma.newsletter.findUnique({
    where: { id: newsletterId },
    select: {
      id: true,
      subject: true,
      audience: true,
      status: true,
      content: true,
      image: { select: { contentType: true, size: true, data: true } },
    },
  });
  if (!issue) return { newsletterId, recipients: 0, sent: 0, failed: 0, skipped: 0, noop: true, reason: 'not_found' };
  if (issue.status !== 'SCHEDULED' && issue.status !== 'SENDING') {
    return { newsletterId, recipients: 0, sent: 0, failed: 0, skipped: 0, noop: true, reason: `status_${issue.status.toLowerCase()}` };
  }

  const variants = normalizeNewsletterContent(issue.content);
  const canonical = canonicalNewsletterContent(variants);
  if (!canonical) {
    // Nothing sendable. Left SCHEDULED rather than marked SENT so the admin
    // sees it is still pending and why.
    logger.error('Newsletter has no sendable content', { newsletterId });
    return { newsletterId, recipients: 0, sent: 0, failed: 0, skipped: 0, noop: true, reason: 'empty_content' };
  }

  // Claim it. `status: 'SCHEDULED'` in the filter makes this a compare-and-set,
  // so a second concurrent tick finds 0 rows and walks away. A resumed run
  // (already SENDING) is claimed by the second branch.
  const claimed = await prisma.newsletter.updateMany({
    where: { id: newsletterId, status: issue.status },
    data: { status: 'SENDING' },
  });
  if (claimed.count === 0) {
    return { newsletterId, recipients: 0, sent: 0, failed: 0, skipped: 0, noop: true, reason: 'claimed_elsewhere' };
  }

  const roles = audienceRoles(issue.audience as NewsletterAudience);
  const users = (await prisma.user.findMany({
    where: { isActive: true, role: { in: roles as ('MENTEE' | 'MENTOR')[] } },
    select: { id: true, email: true, role: true, preferredLanguage: true, emailNotifications: true, notificationPrefs: true },
  })) as Recipient[];

  // Resume safety: everyone this issue has already reached.
  const already = new Set(
    (await prisma.newsletterSend.findMany({ where: { newsletterId }, select: { email: true } })).map((r) => r.email)
  );

  const attachments = issue.image
    ? [{
        filename: newsletterImageFilename(issue.image.contentType),
        content: Buffer.from(issue.image.data),
        contentType: issue.image.contentType,
        cid: IMAGE_CID,
      }]
    : undefined;

  let sent = 0;
  let failed = 0;
  // Opted out, or SMTP is not configured on this environment. Counted, but an
  // opt-out deliberately leaves NO NewsletterSend row: storing the address of
  // someone who asked not to be mailed, in order to record not mailing them,
  // is the wrong trade.
  let skipped = 0;
  const recipients = users.filter((u) => u.email && !already.has(u.email));

  await pooled(recipients, async (user) => {
    if (!emailAllowed(user, 'newsletter')) {
      skipped++;
      return;
    }

    const { subject, html, locale } = await renderNewsletterFor({
      variants,
      canonical,
      audience: issue.audience as NewsletterAudience,
      role: user.role,
      preferredLanguage: user.preferredLanguage,
      imageSrc: issue.image ? `cid:${IMAGE_CID}` : null,
      userId: user.id,
    });

    let status: 'SENT' | 'FAILED' | 'SKIPPED' = 'SENT';
    let error: string | null = null;
    try {
      const result = await sendEmail({
        to: user.email,
        subject,
        html,
        category: NEWSLETTER_EMAIL_CATEGORY,
        attachments,
        headers: {
          // Both halves matter: the URL alone gets a "click to unsubscribe"
          // link in Gmail, the One-Click pair gets the native control that
          // needs no page load at all.
          'List-Unsubscribe': `<${newsletterUnsubscribeUrl(user.id)}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });
      status = result === 'SKIPPED' ? 'SKIPPED' : 'SENT';
    } catch (e) {
      status = 'FAILED';
      error = e instanceof Error ? e.message : String(e);
      // Already logged (and EmailLog-recorded) inside sendEmail; here it only
      // decides this recipient's row.
    }

    if (status === 'SENT') sent++;
    else if (status === 'FAILED') failed++;
    else skipped++;

    try {
      await prisma.newsletterSend.create({
        data: { newsletterId, userId: user.id, email: user.email, locale, status, error },
      });
    } catch (e) {
      // A unique-constraint hit here means a concurrent run got there first —
      // which is the guarantee working, not a problem.
      logger.warning('Newsletter send row not written', { newsletterId, error: String(e) });
    }
  });

  await prisma.newsletter.update({
    where: { id: newsletterId },
    data: {
      status: 'SENT',
      sentAt: new Date(),
      // Cumulative across resumed runs: `increment` rather than `set`, so a
      // second pass over a half-sent issue adds to the tally instead of
      // replacing it with only what this pass did.
      recipientCount: { increment: recipients.length },
      sentCount: { increment: sent },
      failedCount: { increment: failed },
      skippedCount: { increment: skipped },
    },
  });

  await logActivity({
    action: 'newsletter.sent',
    targetType: 'newsletter',
    targetId: newsletterId,
    detail: JSON.stringify({ sent, failed, skipped, recipients: recipients.length }).slice(0, 191),
  });

  return { newsletterId, recipients: recipients.length, sent, failed, skipped };
}

/** Every SCHEDULED issue whose time has come, plus any run left mid-flight. */
export async function dispatchDueNewsletters(now: Date = new Date()): Promise<{
  dispatched: number;
  results: NewsletterDispatchResult[];
}> {
  const due = await prisma.newsletter.findMany({
    where: {
      OR: [
        { status: 'SCHEDULED', scheduledAt: { not: null, lte: now } },
        // A process that died mid-send leaves this behind. Re-running is safe
        // (see the unique constraint) and the alternative is an issue that
        // reached half its audience and then stopped forever.
        { status: 'SENDING' },
      ],
    },
    select: { id: true },
    orderBy: { scheduledAt: 'asc' },
    take: 10,
  });

  const results: NewsletterDispatchResult[] = [];
  for (const issue of due) {
    try {
      results.push(await dispatchNewsletter(issue.id));
    } catch (e) {
      logger.error('Newsletter dispatch failed', { newsletterId: issue.id, error: String(e) });
    }
  }
  return { dispatched: results.filter((r) => !r.noop).length, results };
}

const CADENCE_DAYS: Record<string, number> = { weekly: 7, biweekly: 14, monthly: 30 };

/**
 * The unattended cadence: queue the next unused issue from the curated library
 * when enough time has passed since the last one.
 *
 * It SCHEDULES rather than sends — for the configured hour of the same day — so
 * there is always a window in which a human can read what is about to go out,
 * edit a line, or cancel it. An automated newsletter that mails the moment it
 * is decided is the kind of feature that sends the wrong issue to 400 people at
 * 6am.
 */
export async function queueScheduledNewsletter(now: Date = new Date()): Promise<{
  queued: boolean;
  reason?: string;
  newsletterId?: string;
  templateKey?: string;
  scheduledAt?: Date;
}> {
  const cadence = await getSetting('newsletterSchedule');
  const days = CADENCE_DAYS[cadence];
  if (!days) return { queued: false, reason: 'disabled' };

  // Anything already waiting means the previous cycle has not gone out yet.
  const pending = await prisma.newsletter.count({ where: { status: { in: ['SCHEDULED', 'SENDING'] } } });
  if (pending > 0) return { queued: false, reason: 'already_pending' };

  const last = await prisma.newsletter.findFirst({
    where: { status: 'SENT' },
    orderBy: { sentAt: 'desc' },
    select: { sentAt: true },
  });
  if (last?.sentAt && now.getTime() - last.sentAt.getTime() < days * 24 * 60 * 60 * 1000) {
    return { queued: false, reason: 'too_soon' };
  }

  const audience = (await getSetting('newsletterAudience')) as NewsletterAudience;
  // Which library entries have been used before — so the cadence walks the
  // library instead of re-sending its first issue forever.
  const used = await prisma.newsletter.findMany({
    where: { templateKey: { not: null } },
    select: { templateKey: true },
  });
  const template = nextUnusedTemplate(
    used.map((u) => u.templateKey!).filter(Boolean),
    ['MENTEE', 'MENTOR', 'BOTH'].includes(audience) ? audience : 'MENTEE'
  );
  // Exhausted. Reported rather than looped: "we are out of content" is
  // something an admin has to know, and quietly re-sending old issues is worse
  // than sending nothing.
  if (!template) return { queued: false, reason: 'library_exhausted' };

  const hour = Math.min(23, Math.max(0, parseInt(await getSetting('newsletterSendHour'), 10) || 9));
  const scheduledAt = new Date(now);
  scheduledAt.setHours(hour, 0, 0, 0);
  // Past that hour already (the job ran late, or the hour is set early): go
  // tomorrow rather than immediately, so the review window is never zero.
  if (scheduledAt <= now) scheduledAt.setDate(scheduledAt.getDate() + 1);

  const canonical = template.content[defaultLocale];
  const created = await prisma.newsletter.create({
    data: {
      templateKey: template.key,
      audience: template.audience,
      status: 'SCHEDULED',
      subject: canonical.subject,
      content: template.content as unknown as Prisma.InputJsonValue,
      scheduledAt,
      // Queued by the schedule, not by a person. The column is required, and a
      // sentinel is more honest than borrowing some admin's id.
      createdById: 'system',
    },
    select: { id: true },
  });

  await logActivity({
    action: 'newsletter.queued',
    targetType: 'newsletter',
    targetId: created.id,
    detail: `${template.key} → ${scheduledAt.toISOString()}`.slice(0, 191),
  });

  return { queued: true, newsletterId: created.id, templateKey: template.key, scheduledAt };
}

const tasks = new Map<string, ReturnType<typeof cron.schedule>>();

/**
 * Registers the two newsletter schedules in this server process. Idempotent —
 * a retried call from `/api/cron/start` is harmless.
 */
export function initNewsletterCron() {
  if (tasks.has('newsletter-dispatch')) return;

  // Every 15 minutes: sends whatever has come due. Not hourly, because an admin
  // who schedules an issue for 14:30 means 14:30, and not every minute because
  // the query is pointless 59 times out of 60.
  const dispatch = cron.schedule('*/15 * * * *', async () => {
    try {
      const { dispatched } = await dispatchDueNewsletters();
      if (dispatched > 0) logger.info('Newsletter dispatch ran', { dispatched });
    } catch (e) {
      logger.error('Newsletter dispatch cron failed', { error: String(e) });
    }
  });
  tasks.set('newsletter-dispatch', dispatch);

  // Daily at 06:00: decides whether this cycle's issue should be queued. Early
  // enough that the default 09:00 send still leaves three hours of review.
  const queue = cron.schedule('0 6 * * *', async () => {
    try {
      const result = await queueScheduledNewsletter();
      if (result.queued) logger.info('Newsletter queued by schedule', { ...result });
      else if (result.reason === 'library_exhausted') {
        logger.warning('Newsletter cadence is on but the curated library is exhausted');
      }
    } catch (e) {
      logger.error('Newsletter queue cron failed', { error: String(e) });
    }
  });
  tasks.set('newsletter-queue', queue);

  logger.info('Newsletter cron jobs registered');
}
