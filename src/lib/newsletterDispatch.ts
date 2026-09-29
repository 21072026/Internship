import cron from 'node-cron';
import { defaultOrgId } from '@/lib/defaultOrg';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { logActivity } from '@/lib/activity';
import { emailGroupAllowedForCategory } from '@/lib/emailGroups';
import { getOrgBranding } from '@/lib/orgBranding';
import type { ResolvedBranding } from '@/lib/branding';
import { getSetting } from '@/lib/settings';
import { broadcastMonth, checkBroadcastQuota, type BroadcastQuotaCheck } from '@/lib/broadcastQuota';
import { buildNewsletterQuotaHoldAlert, runNewsletterTick } from '@/lib/newsletterQuotaHold';
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
  /**
   * Set only when `reason` is `'broadcast_quota_exceeded'`: the band of the
   * first tenant in the audience that would be crossed, so the route can return
   * a 403 the admin can act on instead of a bare refusal (#1754).
   */
  quota?: BroadcastQuotaCheck;
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
  /** Which tenant's brand this person's copy carries. Null → product default. */
  orgId: string | null;
  preferredLanguage: string | null;
  emailNotifications: boolean | null;
  notificationPrefs: Prisma.JsonValue;
}

/**
 * Resolved branding for one dispatch run, memoised by `orgId` (`''` = no org).
 *
 * The brand has to be resolved per RECIPIENT (#1667): one issue fans out across
 * people who may belong to different organizations, so a single lookup hoisted
 * out of the send loop would stamp whoever happened to be first onto everybody
 * else's copy. Resolving inside the loop is correct but would read a row per
 * recipient; this keeps the correctness and pays one query per *tenant* — the
 * 400 members of one org cost one lookup.
 *
 * It caches the promise rather than the value, so the recipients the pool has in
 * flight at once (SEND_CONCURRENCY) share a single query instead of racing to
 * issue the same one.
 *
 * Created per run and never at module scope: branding edited between two issues
 * must show up in the second one.
 */
export type NewsletterBrandCache = Map<string, Promise<ResolvedBranding>>;

export function newNewsletterBrandCache(): NewsletterBrandCache {
  return new Map();
}

function brandFor(orgId: string | null | undefined, cache?: NewsletterBrandCache): Promise<ResolvedBranding> {
  const key = orgId ?? '';
  const hit = cache?.get(key);
  if (hit) return hit;
  const pending = getOrgBranding(orgId ?? null);
  cache?.set(key, pending);
  return pending;
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
  /**
   * The reader's tenant. Their organization's name, logo and accent brand this
   * copy; null (no org, or a caller with no tenant context) keeps the product
   * default, which is what a single-tenant install has always sent.
   */
  orgId?: string | null;
  /** Per-run memo, so a fan-out over one tenant reads its branding once. */
  brandCache?: NewsletterBrandCache;
}): Promise<{ subject: string; html: string; locale: Locale }> {
  const { variants, canonical, audience, role, preferredLanguage, imageSrc, userId, orgId, brandCache } = options;
  const locale = resolveNewsletterLocale(variants, preferredLanguage);
  const content = resolveNewsletterContent(variants, canonical, preferredLanguage);
  const brand = await brandFor(orgId, brandCache);

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
 * Everyone this issue would still mail: the active members of ITS tenant in its
 * audience, with an address, minus everyone a previous run already reached.
 *
 * Shared by the dispatcher and by the history's "on hold" line
 * (`newsletterQuotaHold`), so the figure an admin is shown is the figure the
 * dispatcher meters — a second resolution of the audience would be a second
 * answer to the same question.
 */
async function pendingRecipients(issue: { id: string; audience: string; orgId: string | null }): Promise<Recipient[]> {
  const roles = audienceRoles(issue.audience as NewsletterAudience);
  // Scope recipients to the issue's own tenant (#2357). This runs from the cron
  // with no request context, so the middleware does not engage; the issue row
  // carries its orgId and we filter by it explicitly, so a marketing issue never
  // reaches an internship tenant's members. A legacy issue with orgId = NULL
  // (backfilled to the default org on deploy) still resolves to one tenant.
  const users = (await prisma.user.findMany({
    where: { isActive: true, role: { in: roles as ('MENTEE' | 'MENTOR')[] }, orgId: issue.orgId },
    select: { id: true, email: true, role: true, orgId: true, preferredLanguage: true, emailNotifications: true, notificationPrefs: true },
  })) as Recipient[];

  // Resume safety: everyone this issue has already reached.
  const already = new Set(
    (await prisma.newsletterSend.findMany({ where: { newsletterId: issue.id }, select: { email: true } })).map((r) => r.email)
  );

  return users.filter((u) => u.email && !already.has(u.email));
}

/**
 * The broadcast quota (#1754): the first tenant band this send would cross, or
 * null when it fits.
 *
 * Counted per tenant, over the recipients that would ACTUALLY be mailed —
 * someone who opted out is skipped by the send loop and costs the sending domain
 * nothing, so metering them would refuse sends that were never going to happen.
 * A resumed run only ever asks for what is left to send, so finishing a
 * half-delivered issue is never blocked by the half already delivered.
 *
 * ALL-OR-NOTHING PER ISSUE, deliberately. An issue that would cross its band is
 * refused whole and nothing is sent — never truncated to the part that fits,
 * because a sent issue is immutable and undeletable (docs/newsletter.md): the
 * rest of the list could never receive it. Refusing whole keeps the issue
 * re-sendable once the month rolls over, the plan changes or the operator
 * raises the cap. Since #2357 an issue reaches only its own tenant, so the band
 * that can hold it is that tenant's alone; the loop still walks every tenant the
 * recipients resolve to, so a row that ever spans two again is metered against
 * each of them rather than against whichever came first.
 *
 * NEVER CALLED FOR A RESUME. A SENDING issue is finishing a run the quota
 * already authorised. Metering it again would double-count —
 * `checkBroadcastQuota` reads NewsletterSend rows in the window, which by then
 * include this issue's own delivered half — and because the refusal returns
 * BEFORE the claim, it would strand the row in SENDING: half-delivered,
 * un-editable and un-cancellable, the precise outcome the ordering exists to
 * prevent.
 */
async function quotaRefusal(recipients: Recipient[]): Promise<BroadcastQuotaCheck | null> {
  const quotaByOrg = new Map<string, number>();
  for (const user of recipients) {
    if (!user.orgId) continue; // no tenant resolves → unmetered, like planGate
    if (!emailGroupAllowedForCategory(user, 'newsletter')) continue;
    quotaByOrg.set(user.orgId, (quotaByOrg.get(user.orgId) ?? 0) + 1);
  }
  for (const [orgId, requested] of quotaByOrg) {
    const quota = await checkBroadcastQuota({ orgId, requested });
    if (!quota.allowed) return quota;
  }
  return null;
}

/** The part of a quota refusal the history hands to the composer (#2335). */
export interface NewsletterQuotaHold {
  limit: number | null;
  used: number;
  requested: number;
  remaining: number | null;
  resetsAt: string;
}

/**
 * Is this issue due and being held by its tenant's broadcast band right now?
 * The history's "on hold" line (#2335).
 *
 * Only a SCHEDULED issue whose time has come can be held: a future one may still
 * fit when its date arrives (the meter resets monthly), and calling it blocked
 * would be a forecast, not a fact. Evaluated with the dispatcher's own audience
 * and meter, never a copy of them.
 */
export async function newsletterQuotaHold(
  issue: { id: string; audience: string; orgId: string | null; status: string; scheduledAt: Date | null },
  now: Date = new Date(),
): Promise<NewsletterQuotaHold | null> {
  if (issue.status !== 'SCHEDULED' || !issue.scheduledAt || issue.scheduledAt > now) return null;
  const quota = await quotaRefusal(await pendingRecipients(issue));
  if (!quota) return null;
  return {
    limit: quota.limit,
    used: quota.used,
    requested: quota.requested,
    remaining: quota.remaining,
    resetsAt: quota.resetsAt.toISOString(),
  };
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
      orgId: true,
      // Not the image: its bytes are loaded only once the issue is claimed
      // below. A held issue is refused before that, every tick until its band
      // allows, and must not pull the hero blob each time just to be refused.
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

  // The audience is resolved BEFORE the issue is claimed, because the broadcast
  // quota below has to see the whole recipient count while nothing has happened
  // yet: a refusal must leave the issue exactly as it was (still SCHEDULED, so
  // the cron retries it and a human can still edit or cancel it), and a claimed
  // row that then refuses to send would be stuck in SENDING for good.
  const recipients = await pendingRecipients(issue);

  // A RESUME IS NEVER METERED — see quotaRefusal(). When `issue.status` is
  // already 'SENDING' this call is finishing a run the quota already
  // authorised, and it can never mail more than that authorisation covered.
  const quota = issue.status === 'SENDING' ? null : await quotaRefusal(recipients);
  if (quota) {
    logger.warning('Newsletter refused by the broadcast quota', {
      newsletterId,
      orgId: quota.orgId,
      used: quota.used,
      limit: quota.limit,
      requested: quota.requested,
    });
    return {
      newsletterId,
      recipients: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      noop: true,
      reason: 'broadcast_quota_exceeded',
      quota,
    };
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

  const image = await prisma.newsletterImage.findUnique({
    where: { newsletterId },
    select: { contentType: true, data: true },
  });
  const attachments = image
    ? [{
        filename: newsletterImageFilename(image.contentType),
        content: Buffer.from(image.data),
        contentType: image.contentType,
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
  // One memo for the whole fan-out; see NewsletterBrandCache.
  const brandCache = newNewsletterBrandCache();

  await pooled(recipients, async (user) => {
    // The group check, not the bare legacy key. They agree today — 'newsletter'
    // is the `newsletter` group's own legacy key — but only this form honours an
    // explicit opt-back-IN: someone who used the newsletter's own unsubscribe
    // (which writes `newsletter: false`) and later re-enabled "Career newsletter"
    // in the preference centre has `email:newsletter: true`, and the bare key
    // would keep suppressing them while both surfaces showed the group as ON.
    // That mismatch is the same one this PR removed from ten other call sites.
    if (!emailGroupAllowedForCategory(user, 'newsletter')) {
      skipped++;
      return;
    }

    const { subject, html, locale } = await renderNewsletterFor({
      variants,
      canonical,
      audience: issue.audience as NewsletterAudience,
      role: user.role,
      preferredLanguage: user.preferredLanguage,
      imageSrc: image ? `cid:${IMAGE_CID}` : null,
      userId: user.id,
      orgId: user.orgId,
      brandCache,
    });

    let status: 'SENT' | 'FAILED' | 'SKIPPED' = 'SENT';
    let error: string | null = null;
    try {
      const result = await sendEmail({
        to: user.email,
        subject,
        html,
        category: NEWSLETTER_EMAIL_CATEGORY,
        // The recipient, so the `newsletter` group is enforced centrally as well
        // as by the guard above. This send keeps its OWN opt-out presentation —
        // it supplies a List-Unsubscribe below, which suppresses the generic
        // footer and header pair — but owning the presentation is not a reason
        // to sit outside the one check that cannot be forgotten.
        userId: user.id,
        prefs: user,
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

/** The ActivityLog action a held issue writes, once per broadcast month. */
export const NEWSLETTER_QUOTA_HOLD_ACTION = 'newsletter.quota_hold';
const OPS_ALERT_CATEGORY = 'ops-alert';

/**
 * Make held issues loud — ONCE (#2335).
 *
 * An issue nobody pressed Send on (the cadence's own, or one an admin scheduled
 * for a date) used to leave nothing behind but a server-log warning every
 * fifteen minutes; for a cron-driven issue there is no 403 for anybody to read.
 * The first time a tick finds an issue held in a broadcast month, this writes
 * one ActivityLog row for it, then mails ALERT_EMAIL_TO — one mail per tick,
 * covering every issue the tick newly found held, so a tenant with several
 * queued issues is one mail, not several. The row is the dedupe key
 * (restart-safe, unlike an in-memory timer) and the durable record — written
 * FIRST, the same order the dead-letter alert uses, so it exists even when the
 * mail cannot leave.
 *
 * The row carries the tenant's id and nothing else about it: the activity feed
 * is installation-wide today, so another tenant's name and broadcast figures
 * stay in the operator's mail (and in the tenant's own history line), not in a
 * list every ADMIN can page through.
 *
 * Never throws: failing to report a hold must not turn into failing the tick.
 */
async function reportNewsletterQuotaHolds(
  held: { newsletterId: string; quota: BroadcastQuotaCheck }[],
  now: Date,
): Promise<void> {
  if (held.length === 0) return;
  try {
    const { start } = broadcastMonth(now);
    const reported = new Set(
      (
        await prisma.activityLog.findMany({
          where: {
            action: NEWSLETTER_QUOTA_HOLD_ACTION,
            targetId: { in: held.map((h) => h.newsletterId) },
            createdAt: { gte: start },
          },
          select: { targetId: true },
        })
      ).map((row) => row.targetId),
    );
    const fresh = held.filter((h) => !reported.has(h.newsletterId));
    if (fresh.length === 0) return;

    const orgIds = [...new Set(fresh.map((h) => h.quota.orgId).filter((id): id is string => !!id))];
    const [issues, orgs] = await Promise.all([
      prisma.newsletter.findMany({
        where: { id: { in: fresh.map((h) => h.newsletterId) } },
        select: { id: true, subject: true, scheduledAt: true },
      }),
      orgIds.length
        ? prisma.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true, slug: true } })
        : Promise.resolve([]),
    ]);
    const issueById = new Map(issues.map((i) => [i.id, i]));
    const orgById = new Map(orgs.map((o) => [o.id, o]));

    for (const { newsletterId, quota } of fresh) {
      await logActivity({
        level: 'warning',
        action: NEWSLETTER_QUOTA_HOLD_ACTION,
        targetType: 'newsletter',
        targetId: newsletterId,
        // ActivityLog.detail is VARCHAR(191) and an oversized value is silently
        // dropped (P2000, the #1268 lesson) — and see above for why this is
        // all it says about the tenant.
        detail: JSON.stringify({ orgId: quota.orgId, month: start.toISOString().slice(0, 7) }).slice(0, 191),
      });
    }

    const alertTo = process.env.ALERT_EMAIL_TO;
    if (!alertTo) return;
    const message = buildNewsletterQuotaHoldAlert(
      fresh.map(({ newsletterId, quota }) => {
        const issue = issueById.get(newsletterId);
        const org = quota.orgId ? orgById.get(quota.orgId) : undefined;
        return {
          newsletterId,
          subject: issue?.subject ?? '',
          orgName: org?.name ?? null,
          orgSlug: org?.slug ?? null,
          used: quota.used,
          limit: quota.limit,
          requested: quota.requested,
          remaining: quota.remaining,
          resetsAt: quota.resetsAt.toISOString(),
          scheduledAt: issue?.scheduledAt?.toISOString() ?? null,
        };
      }),
    );
    const delivery = await sendEmail({
      to: alertTo,
      subject: message.subject,
      html: message.html,
      category: OPS_ALERT_CATEGORY,
      // no-user-row: ALERT_EMAIL_TO is an operator alert address configured in
      // the server env, not a User row — there is no preference to read and no
      // unsubscribe token to mint for it.
    });
    if (delivery !== 'SENT') {
      logger.warning('Newsletter quota-hold alert was not delivered', { held: fresh.length, delivery });
    }
  } catch (e) {
    logger.error('Newsletter quota hold could not be reported', { held: held.length, error: String(e) });
  }
}

/**
 * Every SCHEDULED issue whose time has come, plus any run left mid-flight.
 *
 * Which of them one tick attempts is `runNewsletterTick`'s rule
 * (src/lib/newsletterQuotaHold.ts, #2335): an issue its tenant's band is
 * holding does not take a slot another tenant's issue could use, every issue is
 * still metered on its own, a tenant's held attempts per tick are capped, and a
 * resume is never skipped. Before that rule, the ten oldest due issues were
 * attempted whatever happened to them — so ten held issues from one tenant
 * whose month was spent stopped every other tenant's newsletter until that one
 * tenant's meter reset.
 */
export async function dispatchDueNewsletters(now: Date = new Date()): Promise<{
  dispatched: number;
  results: NewsletterDispatchResult[];
  /** Due SCHEDULED issues left for the next tick because their tenant used up its held attempts. */
  deferred: string[];
}> {
  // Ids, tenants and states only, and deliberately no `take`: the per-tick cap
  // is the rule's budget, counted over attempts that could mail someone. A
  // `take` here would cap the SCAN instead, and one tenant's held backlog could
  // fill it. `status` is what tells the rule a row is a resume.
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
    select: { id: true, orgId: true, status: true },
    orderBy: { scheduledAt: 'asc' },
  });

  const { results, deferred } = await runNewsletterTick(
    due,
    async (issue) => {
      try {
        return await dispatchNewsletter(issue.id);
      } catch (e) {
        logger.error('Newsletter dispatch failed', { newsletterId: issue.id, error: String(e) });
        return null;
      }
    },
    { isHeld: (result) => !!result.quota },
  );

  await reportNewsletterQuotaHolds(
    results.flatMap((r) => (r.quota ? [{ newsletterId: r.newsletterId, quota: r.quota }] : [])),
    now,
  );
  return { dispatched: results.filter((r) => !r.noop).length, results, deferred };
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

  // The cadence is the default org's — its issues are stamped with it below
  // (#2357) — so every read that GATES it is scoped to that org too (#2335).
  // Unscoped, any other tenant's issue counted as "the previous cycle": one held
  // by its own tenant's spent band stopped this cadence until that tenant's
  // month rolled over, and another tenant's send reset "too soon" for an
  // audience that never received it.
  const orgId = await defaultOrgId();

  // Anything already waiting means the previous cycle has not gone out yet.
  const pending = await prisma.newsletter.count({ where: { orgId, status: { in: ['SCHEDULED', 'SENDING'] } } });
  if (pending > 0) return { queued: false, reason: 'already_pending' };

  const last = await prisma.newsletter.findFirst({
    where: { orgId, status: 'SENT' },
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
    where: { orgId, templateKey: { not: null } },
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
      // Curated library issues are the internship product's content, so they
      // belong to the default org (#2357). A marketing tenant's own newsletter
      // cadence is separate future work; scoping here keeps an internship issue
      // from reaching a marketing tenant's members via dispatchNewsletter's
      // recipient filter.
      orgId,
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
