import nodemailer from 'nodemailer';
import cron from 'node-cron';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { sweepMeetingInteractionLogs } from '@/lib/meetingAutoLog';
import { purgeExpiredTrustedDevices } from '@/lib/trustedDevice';
import { logger } from '@/lib/logger';
import { getEmailHealth, type EmailHealth } from '@/lib/emailHealth';
import { logActivity } from '@/lib/activity';
import { notify, notifyIfAllowed } from '@/lib/notify';
import { markReadUrl } from '@/lib/emailActionToken';
import { getSetting } from '@/lib/settings';
import { emailAllowed, notificationCategoryAllowed } from '@/lib/notificationPrefs';
import { makeConsentRenewToken } from '@/lib/consentRenew';
import { dueForReminder, makeLeaveToken } from '@/lib/reEngagement';
import { getRetentionMonths, RETENTION_GRACE_DAYS } from '@/lib/retention';
import { getMentorMenteeActivity, getSystemMenteeActivity, formatDuration, type MenteeActivity } from '@/lib/activityReport';
import { findDormantFirstContacts, sweepDormantFirstContacts } from '@/lib/dormantFirstContact';
import { getOrgBranding } from '@/lib/orgBranding';
import { formatInTimeZone, readingsByZone, resolveTimeZone, sameWallClock, zoneLabel, type ZonedPerson } from '@/lib/timezone';
import { seriesOccurrences } from '@/lib/meetingSeriesOccurrences';
import { buildMeetingIcs } from '@/lib/ics';
import { loadProjectTeam } from '@/lib/projectTeam';
import { getDictionary } from '@/i18n/dictionaries';
import { defaultLocale, isLocale, type Locale } from '@/i18n/config';
import { bulkMissingRequirements } from '@/lib/documentRequirements';
import { utcWeekStart } from '@/lib/week';
import { SUBMITTED_WEEKLY_REPORT_STATUSES } from '@/lib/weeklyReports';
import { IS_DEMO_MODE } from '@/lib/demoMode';
import {
  BULK_GROUP_CATEGORIES,
  emailGroupAllowed,
  emailGroupAllowedForCategory,
  groupForCategory,
  isBulkGroup,
  isEssentialGroup,
  type EmailGroupId,
  type EmailPrefUser,
} from '@/lib/emailGroups';
import { emailPreferencesUrl, oneClickUnsubscribeUrl, unsubscribeUrl } from '@/lib/unsubscribeToken';

// Resolved branding for a transactional email (#546). When no orgId is given
// (single-tenant, or a caller without tenant context) this returns the product
// defaults, so behavior is unchanged. The accent falls back to the product blue.
const DEFAULT_ACCENT = '#2563eb';
async function emailBrand(orgId?: string | null) {
  const b = await getOrgBranding(orgId ?? null);
  return {
    name: b.name,
    accent: b.color || DEFAULT_ACCENT,
    logoUrl: b.logoUrl,
    supportEmail: b.supportEmail,
  };
}

// A small brand header (logo if the tenant set one, otherwise the heading text).
// Every value here is tenant-supplied (Organization.brandName / brandLogoUrl /
// brandColor), so all three are attribute-escaped: unescaped, a `"` in a brand
// name or logo URL closes the attribute and the rest of the string becomes
// markup in every transactional email that org sends. `brandLogoUrl` is also
// scheme-checked on write (isSafeBrandLogoUrl) and `brandColor` must be a hex
// value; escaping here is the second layer, for rows written before those
// checks existed.
function brandHeader(brand: { name: string; accent: string; logoUrl: string | null }, heading: string): string {
  const logo = brand.logoUrl
    ? `<img src="${esc(brand.logoUrl)}" alt="${esc(brand.name)}" style="max-height:40px;margin-bottom:12px;" />`
    : '';
  return `${logo}<h2 style="color: ${esc(brand.accent)};">${heading}</h2>`;
}

// Bounded waits so an unreachable or wedged SMTP host fails fast instead of
// hanging the request that triggered the send — without these, the admin email
// panel (which verifies both channels) blocks until the platform's own timeout.
const SMTP_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
} as const;

const smtpPort = Number(process.env.SMTP_PORT) || 587;
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: smtpPort,
  secure: smtpPort === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  ...SMTP_TIMEOUTS,
});

// ---------------------------------------------------------------------------
// Two outbound channels (#1203).
//
// A reputable relay is what gets mail that MUST reach a human into the inbox —
// a verification link, an invitation, a password reset, a message notification.
// Those go to people who may not be engaged with us at all, and one that lands
// in spam costs a user. But relays meter: Brevo's free tier is 300/day across
// everything, and this app's own scheduled mail (hourly unread digests, daily
// reminders and activity digests, weekly digests and analytics, announcements
// to every user) eats that budget without any of it being urgent.
//
// So: critical mail rides the relay, bulk/system mail keeps going out over our
// own server, ideally under a separate From identity so the two reputations
// stay independent (a digest marked as spam must not drag the password-reset
// mail down with it).
//
// The bulk channel is OPTIONAL. With SMTP_BULK_HOST unset every category falls
// back to the primary transport, which is exactly today's behaviour — so
// preview and topic environments need no extra configuration.
// ---------------------------------------------------------------------------
const bulkSmtpPort = Number(process.env.SMTP_BULK_PORT) || 587;
const bulkConfigured = Boolean(process.env.SMTP_BULK_HOST && process.env.SMTP_BULK_USER);
const bulkTransporter = bulkConfigured
  ? nodemailer.createTransport({
      host: process.env.SMTP_BULK_HOST,
      port: bulkSmtpPort,
      secure: bulkSmtpPort === 465,
      auth: {
        user: process.env.SMTP_BULK_USER,
        pass: process.env.SMTP_BULK_PASS,
      },
      ...SMTP_TIMEOUTS,
    })
  : null;

// Categories that ride the bulk channel. Everything else — including any call
// site that passes no category at all — stays on the primary transport. That
// default is deliberate: an uncategorised mail is more likely to be something
// a person is waiting for than a digest, and quietly downgrading its
// deliverability is the kind of regression nobody notices until it matters.
//
// This used to be a hand-maintained list, and it had already drifted from the
// group taxonomy it is supposed to mirror. It is now DERIVED from the groups
// marked `bulk: true` in src/lib/emailGroups.ts, so "which mail is automated
// volume?" is answered in exactly one place.
//
// One deliberate exception, unioned in below: 'retention-reminder' belongs to an
// ESSENTIAL group (a legally required notice — never unsubscribable, no List-*
// headers, no footer) that nevertheless belongs on the bulk relay. Which
// transport carries a mail is a *deliverability* decision; whether a person may
// opt out of it is a *consent* decision. They are allowed to disagree, and
// silently moving a dated blast back onto the relay that carries password
// resets would spend the reputation the channel split exists to protect.
//
// Diff vs. the hard-coded set this replaced (asserted in
// e2e/email-groups-footer.unit.spec.ts): every previous entry is still here,
// plus three additions the taxonomy already classes as automated volume —
//   + 'weekly-report'            (task_reminders; was on primary by oversight)
//   + 'meeting-series-reminder'  (new category, split out of 'meeting-reminder')
//   + 're-engagement'           (new category; that mail had none at all)
const LEGACY_BULK_CHANNEL = new Set(['retention-reminder']);
const BULK_CATEGORIES = new Set<string>([...BULK_GROUP_CATEGORIES, ...LEGACY_BULK_CHANNEL]);

export type MailTransport = 'primary' | 'bulk';

export function transportFor(category?: string): MailTransport {
  return bulkTransporter && category && BULK_CATEGORIES.has(category) ? 'bulk' : 'primary';
}

// Best-effort HTML → plain text for the multipart alternative. A message with
// only an HTML part scores worse with spam filters (e.g. Gmail); shipping a
// text/plain alternative alongside improves inbox placement.
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, '$2 ($1)')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// A From header with a display name ("Internship CRM <noreply@…>") looks less
// like bulk/spam than a bare address. Honor an address that already includes a
// name; otherwise wrap the configured address.
function fromHeader(brandName?: string | null, transport: MailTransport = 'primary'): string {
  // Bulk mail may carry its own sender identity (e.g. noreply@ersah.in) so that
  // digest complaints never touch the domain the password-reset mail is signed
  // with. Falls back to the primary address when unset, which keeps a
  // single-identity setup working unchanged.
  const addr =
    (transport === 'bulk' ? process.env.SMTP_BULK_FROM : undefined) ||
    process.env.SMTP_FROM ||
    (transport === 'bulk' ? process.env.SMTP_BULK_USER : undefined) ||
    process.env.SMTP_USER ||
    '';
  if (addr.includes('<') || !addr) return addr;
  const name = brandName || process.env.MAIL_FROM_NAME || 'Internship CRM';
  return `${name} <${addr}>`;
}

// Record the outcome of one send attempt (#1194). Never throws and never blocks
// the caller's own error handling: a logging failure must not turn a delivered
// mail into an exception, nor hide the real SMTP error behind a Prisma one.
async function recordEmail(
  to: string,
  subject: string,
  category: string | undefined,
  status: 'SENT' | 'FAILED' | 'SKIPPED',
  transport: MailTransport,
  error?: string,
) {
  try {
    await prisma.emailLog.create({
      data: {
        to: to.slice(0, 320),
        subject: subject.slice(0, 512),
        category: category?.slice(0, 64) ?? null,
        transport,
        status,
        error: error?.slice(0, 2000) ?? null,
      },
    });
  } catch (e) {
    logger.error('Failed to write EmailLog', { to, category, status, error: String(e) });
  }
}

// ── E-mail delivery health alerts (#1190) ───────────────────────────────────
// The channel's own failures must not stay silent, but the alert also travels
// by e-mail — so the alert is best-effort and the durable signals are the
// ActivityLog row and /api/health. In-memory dedupe (6h) is deliberate: after
// a restart one extra alert beats a missed one.
const EMAIL_ALERT_CATEGORY = 'ops-alert';
const EMAIL_ALERT_MIN_FAILURES = 3;
const EMAIL_ALERT_INTERVAL_MS = 6 * 60 * 60 * 1000;
let lastEmailAlertAt = 0;

async function alertEmailHealth(reason: 'consecutive_failures' | 'stale', health: EmailHealth) {
  if (Date.now() - lastEmailAlertAt < EMAIL_ALERT_INTERVAL_MS) return;
  lastEmailAlertAt = Date.now();
  // ActivityLog.detail is VARCHAR(191) — an oversized JSON is silently lost
  // (P2000, the #1268 lesson), so the error is pre-trimmed and the whole
  // payload capped.
  const detail = JSON.stringify({
    reason,
    failuresSinceOk: health.failuresSinceOk,
    lastOkAt: health.lastOkAt,
    lastError: health.lastError?.slice(0, 80) ?? null,
  }).slice(0, 191);
  // The durable record — visible even when the alert e-mail below cannot leave.
  await logActivity({ level: 'error', action: 'email.health_alert', targetType: 'email', detail });
  const alertTo = process.env.ALERT_EMAIL_TO;
  if (!alertTo) return;
  try {
    await sendEmail({
      to: alertTo,
      subject: `[CRM] E-mail delivery ${reason === 'stale' ? 'stalled' : 'failing'} — ${health.failuresSinceOk} failures since last success`,
      html: `<p>E-mail delivery health alert (<b>${reason}</b>).</p><ul><li>Failures since last success: ${health.failuresSinceOk}</li><li>Last success: ${health.lastOkAt ?? 'never'}</li><li>Last error: ${health.lastError ?? '-'}</li></ul><p>Watch /api/health (detail view) for the live state.</p>`,
      category: EMAIL_ALERT_CATEGORY,
    });
  } catch (e) {
    logger.error('Email health alert could not be delivered', { error: String(e) });
  }
}

// Fired after every FAILED attempt (never for the alert channel itself — the
// alert failing must not re-trigger the alert).
async function maybeAlertEmailFailures(category?: string) {
  if (category === EMAIL_ALERT_CATEGORY) return;
  try {
    const health = await getEmailHealth();
    if (health.failuresSinceOk >= EMAIL_ALERT_MIN_FAILURES) await alertEmailHealth('consecutive_failures', health);
  } catch (e) {
    logger.error('Email health evaluation failed', { error: String(e) });
  }
}

// Hourly check (#1190 item 4): the last success is older than 6h while real
// attempts kept happening — the queue is trying and nothing gets through.
export async function runEmailHealthCheck(): Promise<EmailHealth> {
  const health = await getEmailHealth();
  const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
  const stale = (!health.lastOkAt || new Date(health.lastOkAt).getTime() < sixHoursAgo) && health.attempts24h > 0 && health.failuresSinceOk > 0;
  if (stale) await alertEmailHealth('stale', health);
  return health;
}

// ── Per-group unsubscribe: footer + List-* headers (#1444) ──────────────────
//
// Everything below is a pure string builder on purpose. Nothing in this repo
// can inspect a rendered e-mail end to end (Playwright blanks SMTP_USER, so
// sendEmail short-circuits to a SKIPPED EmailLog row, and EmailLog stores no
// body), so the footer and the headers are unit-tested against these functions
// directly — see e2e/email-groups-footer.unit.spec.ts. They are exported through
// `__testable` at the bottom of this block rather than individually, to keep the
// module's public surface honest about what is API and what is test seam.

const UNSUB_FOOTER_MARKER = 'data-unsub-footer="1"';

// ONE LINE, no internal newlines — and that is load-bearing twice over:
//   • htmlToText's anchor regex has no `s` flag, so an <a> broken across lines
//     loses its URL from the text/plain part entirely. Gmail wants the visible
//     opt-out in BOTH MIME parts, so a silently URL-less plain text half would
//     defeat the whole point.
//   • src/lib/outcomeComms.server.ts renders its body inside a
//     `white-space:pre-wrap` div, and this footer is injected *inside* that
//     wrapper — newlines in the markup would render as blank lines there. The
//     footer's own `white-space:normal` defuses the inherited pre-wrap.
function unsubscribeFooterHtml(userId: string, group: EmailGroupId, locale?: string | null): string {
  const dict = getDictionary(resolveLocale(locale));
  const U = dict.unsubscribe;
  const name = dict.emailGroups[group].name;
  const unsub = unsubscribeUrl(userId, group);
  const prefs = emailPreferencesUrl(userId);
  const line = esc(U.footerLine.replace('{group}', name));
  const off = esc(U.footerUnsubscribe.replace('{group}', name));
  const all = esc(U.footerManage);
  return `<div ${UNSUB_FOOTER_MARKER} style="margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px;line-height:1.6;white-space:normal;"><div style="margin-bottom:4px;">${line}</div><div><a href="${unsub}" style="color:#9ca3af;text-decoration:underline;">${off}</a> · <a href="${prefs}" style="color:#9ca3af;text-decoration:underline;">${all}</a></div></div>`;
}

// Injected *inside* the template's own 600px wrapper div where there is one, so
// the footer sits in the same column as the body instead of full-bleed under it.
// The marker check makes it idempotent: a template that already carries a footer
// (or a body that was passed through twice) never gets a second one.
function withUnsubscribeFooter(html: string, footer: string): string {
  if (html.includes(UNSUB_FOOTER_MARKER)) return html;
  const trimmed = html.trimEnd();
  const CLOSE = '</div>';
  return trimmed.endsWith(CLOSE)
    ? `${trimmed.slice(0, -CLOSE.length)}${footer}${CLOSE}`
    : `${html}${footer}`;
}

// RFC 2919 wants a globally unique id in a namespace we own. The app host is
// stable, ASCII and always present; a group id is already a dot-atom.
function listIdHost(): string {
  try {
    return new URL(appUrl()).host;
  } catch {
    return 'localhost';
  }
}

function unsubscribeHeaders(userId: string, group: EmailGroupId): Record<string, string> {
  const one = oneClickUnsubscribeUrl(userId, group);
  // The mailto: form is advertised ONLY when a mailbox is configured, because
  // src/services/inboundMailBridge.ts + routeInboundEmail understand
  // `reply+<token>@` and nothing else — they would black-hole an unsubscribe
  // message. An opt-out address nobody processes is a compliance failure, not a
  // courtesy, so the header entry is omitted rather than emitted empty.
  const mailto = process.env.UNSUBSCRIBE_MAILTO;
  const h: Record<string, string> = {
    // https FIRST: RFC 8058 one-click keys off the https URI, and RFC 2369
    // ordering is preference order, so browser-capable clients pick it.
    'List-Unsubscribe': mailto ? `<${one}>, <mailto:${mailto}?subject=unsubscribe>` : `<${one}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
  // Only automated volume gets the list markers. A 1:1 notification is not a
  // list, and `Precedence: bulk` on the primary channel is a negative signal on
  // exactly the reputation the two-transport split exists to protect — plus
  // these mails often expect a reply through the `reply+` address, which an
  // auto-response suppression header would interfere with.
  if (isBulkGroup(group)) {
    h['List-Id'] = `<${group}.${listIdHost()}>`;
    h['Precedence'] = 'bulk';
    h['Auto-Submitted'] = 'auto-generated';
    h['X-Auto-Response-Suppress'] = 'OOF, AutoReply';
  }
  return h;
}

/**
 * Does this mail get the consent machinery — the preference check, the footer
 * and the List-* headers? All three ride together, and all three answer the
 * same question, so the answer is computed once, here, rather than restated at
 * each of the three use sites in sendEmail() below.
 *
 * Three ways to be exempt, each for its own reason:
 *   • No group. An uncategorised or unmapped category fails OPEN, the same
 *     fail-safe reasoning transportFor() uses — a taxonomy gap must never
 *     swallow mail somebody is waiting for.
 *   • No userId. The recipient is not a User row (an invitee who has not
 *     registered yet, a mentor applicant, ALERT_EMAIL_TO, an operator-typed
 *     test address): there is no preference to read and no token to mint.
 *   • An essential group. Sign-in, security and legally required notices ignore
 *     every switch, and advertising an opt-out on a password reset invites
 *     people to switch off the mail they cannot function without.
 *
 * A named predicate rather than an inline expression because it is the one line
 * that decides whether a mail is unsubscribable at all, and it is the property
 * e2e/email-groups-footer.unit.spec.ts has to be able to ask about directly.
 */
function unsubscribable(groupId: EmailGroupId | null, userId?: string | null): boolean {
  return !!groupId && !!userId && !isEssentialGroup(groupId);
}

/** Test seam for e2e/email-groups-footer.unit.spec.ts — not part of the mail API. */
export const __testable = {
  UNSUB_FOOTER_MARKER,
  BULK_CATEGORIES,
  LEGACY_BULK_CHANNEL,
  unsubscribable,
  unsubscribeFooterHtml,
  withUnsubscribeFooter,
  unsubscribeHeaders,
  htmlToText,
};
// What actually happened to a message, mirroring the EmailLog row this call
// writes (#1431). Returned rather than only recorded, because "did not throw"
// is not the same as "was delivered": the two SKIPPED paths below return
// normally, and four routes were reading that silence as success — reporting
// `emailSent: true` for an account nobody could ever sign in to.
//
// The throw behaviour is deliberately unchanged: a real transport failure still
// throws (and is recorded FAILED first), so every existing try/catch keeps
// working exactly as before. 'FAILED' is in the union for callers that catch and
// want to name the outcome; sendEmail itself never returns it.
export type EmailDeliveryResult = 'SENT' | 'SKIPPED' | 'FAILED';

export async function sendEmail({
  to,
  subject,
  html,
  replyTo,
  attachments,
  fromName,
  category,
  userId,
  group,
  locale,
  prefs,
  headers,
}: {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
  // `cid` makes an attachment *inline*: the HTML can then reference it as
  // <img src="cid:…">, which is how images inside a message body reach mail
  // clients (a URL into this app would need a session and render as broken).
  attachments?: { filename: string; content: Buffer; contentType?: string; cid?: string }[];
  // Overrides the From display name (e.g. a tenant's brand name, #546). Falls
  // back to MAIL_FROM_NAME / "Internship CRM" when omitted.
  fromName?: string | null;
  // Coarse bucket for the delivery log ("verification", "message", …). Optional
  // so the dozens of existing call sites keep compiling; the ones that matter
  // for "did our mail get through?" pass it.
  category?: string;
  // The recipient's User.id. Supplying it is what turns on central unsubscribe
  // enforcement, the footer and the List-* headers — without it there is no
  // preference to read and no token to mint, which is exactly the right
  // behaviour for a recipient who is not a User row (an invitee who has not
  // registered, ALERT_EMAIL_TO, a mentor applicant, an arbitrary test address).
  //
  // Because it is optional, omitting it by accident compiles, delivers and looks
  // healthy while shipping bulk mail with no opt-out at all — so every send in a
  // non-essential group must either pass it or say on the call
  // `// no-user-row: <why>`. e2e/email-groups-footer.unit.spec.ts scans the
  // source for exactly that and names the file, the category and the fix.
  userId?: string | null;
  // Normally derived from `category`; an explicit value wins, for the rare send
  // whose taxonomy home the category cannot express.
  group?: EmailGroupId;
  // The recipient's language, for the FOOTER ONLY. Omit it when the body is
  // English: a translated footer under an untranslated body reads as a bug, not
  // as a courtesy (the same convention timeZoneNote() follows).
  locale?: string | null;
  // The two preference columns, when the caller has ALREADY read them for this
  // recipient. Purely an economy measure, for the one path where it matters:
  // the announcement broadcast selects `emailNotifications` +
  // `notificationPrefs` for every active user in a single query and filters on
  // them in memory, and without this the central check below re-read the same
  // two columns once per recipient — a thousand extra pooled round trips on top
  // of the thousand EmailLog inserts, all inside one Promise.all, against a
  // default Prisma pool of a dozen-odd connections. That is where a P2024 pool
  // timeout comes from, on the largest send the product makes.
  //
  // It is DATA, not a bypass flag, and the distinction is the whole reason this
  // is safe to add: what is passed is the answer to "what did this user
  // choose?", never "should I check?". Omitting it costs a query; it cannot
  // skip the check, and there is deliberately no value of it — and no sibling
  // flag — that means "send anyway". Do not add one.
  //
  // Deliberately NOT threaded through the scheduled jobs: the digests already
  // run several queries per recipient, so one more changes nothing there, and
  // every extra call site that hand-carries preference data is another place
  // for the row and the decision to drift apart.
  prefs?: EmailPrefUser;
  // Extra SMTP headers, from a caller that owns its own opt-out presentation.
  // Added for the newsletter's List-Unsubscribe pair
  // (#1469), which is what makes Gmail and Outlook render their own native
  // "unsubscribe" control next to the sender — a reader who uses that never
  // reaches for the spam button, and the spam button is what costs the whole
  // sending domain. Nothing else needs it, hence optional.
  //
  // These WIN over the pair this function computes for a gated send, and such a
  // caller also gets no footer: a send that brought its own List-Unsubscribe has
  // said it owns the opt-out, and two of them is worse than either. See the merge
  // in the body below.
  headers?: Record<string, string>;
}) {
  // No SMTP on this environment. This used to be a bare console.log + return,
  // which made a misconfigured or broken mail setup indistinguishable from a
  // user who simply never replied (#1194) — the whole reason a batch of
  // never-activated sign-ups went unexplained. Log it loudly and leave a row
  // behind so the admin mail view can show it.
  // Which channel carries this one (#1203). Resolves to 'primary' whenever the
  // bulk transport is not configured, so a single-SMTP setup is unchanged.
  const transport = transportFor(category);
  const via = transport === 'bulk' ? bulkTransporter! : transporter;

  const groupId = group ?? groupForCategory(category);
  const gated = unsubscribable(groupId, userId);

  // ── CENTRAL ENFORCEMENT ───────────────────────────────────────────────────
  //
  // This — not the call sites — is the guarantee that an unsubscribe applies to
  // every mail we send. There are 41 send sites in this codebase and nine of
  // them had no per-user preference check at all before this change; the next
  // one somebody adds will forget too. The per-call-site checks stay (they keep
  // the scheduled jobs' returned `{ emailed: n }` counters truthful, which
  // several e2e specs assert), but they are an optimisation. This is the one
  // that cannot be forgotten.
  //
  // Deliberately placed AHEAD of the demo-mode and SMTP short-circuits below,
  // so the promise holds in every environment and the SKIPPED row records *why*:
  // "Unsubscribed: digests" is auditable, "Demo mode" is not.
  if (gated) {
    // `prefs` when the caller already holds this recipient's row, a read
    // otherwise. Same decision either way — see the parameter's note above.
    const u =
      prefs ??
      (await prisma.user
        .findUnique({ where: { id: userId! }, select: { emailNotifications: true, notificationPrefs: true } })
        .catch(() => null));
    // Fail OPEN on a missing row or a DB error, exactly like notifyIfAllowed: a
    // preference lookup that breaks must not silently swallow the mail.
    if (u && !emailGroupAllowed(u, groupId!)) {
      logger.info('Email not sent: unsubscribed', { to, category, group: groupId });
      await recordEmail(to, subject, category, 'SKIPPED', transport, `Unsubscribed: ${groupId}`);
      // 'SKIPPED', never a bare return: #1431 made this function report what
      // actually happened, because four routes had been reading "did not throw"
      // as "was delivered". A suppressed send is the newest way for a mail not
      // to arrive, so it owes callers the same honest answer as the demo-mode
      // and no-SMTP paths below.
      return 'SKIPPED';
    }
  }

  // Public demo (#966): never deliver. The demo accounts are synthetic
  // @demo.example.com addresses, but a visitor can type any address into an
  // invite or a mentor application, which would turn the demo into an open
  // relay pointed at strangers. Skipping here rather than blocking the routes
  // keeps every flow clickable, and the SKIPPED row means the admin email view
  // still shows what would have gone out — which is the part worth demoing.
  if (IS_DEMO_MODE) {
    logger.info('Email not sent: demo mode', { to, subject, category });
    await recordEmail(to, subject, category, 'SKIPPED', transport, 'Demo mode — delivery disabled');
    return 'SKIPPED';
  }

  if (!process.env.SMTP_USER) {
    logger.error('Email not sent: SMTP is not configured', { to, subject, category });
    await recordEmail(to, subject, category, 'SKIPPED', transport, 'SMTP not configured (SMTP_USER unset)');
    return 'SKIPPED';
  }

  // The footer and the headers ride together and only on gated (non-essential,
  // known-recipient) mail. Advertising an opt-out on a password reset invites
  // people to switch off the mail they cannot function without.
  //
  // Note this is deliberately NOT nodemailer's `list:` option: `_formatListUrl`
  // mangles `list: { 'unsubscribe-post': … }` into
  // `<http://List-Unsubscribe=One-Click>`. Raw `headers` pass ASCII through
  // verbatim, which is what RFC 8058 needs.
  // A caller that supplied its own `List-Unsubscribe` owns the opt-out for this
  // message, and gets neither our footer nor our header pair. The newsletter
  // (#1469) is that caller: it renders its own unsubscribe link in the body and
  // points its header at its own route. Adding a second link and a second
  // List-Unsubscribe would not be twice as good — a duplicate header is resolved
  // arbitrarily by the client, so the two mechanisms would disagree about which
  // one a native "Unsubscribe" button actually hit.
  //
  // Keyed on the header rather than a new boolean deliberately: the condition IS
  // the evidence. A caller cannot claim to own the opt-out without shipping the
  // thing that provides it, and there is no flag to set stale.
  const callerOwnsOptOut = !!headers && Object.keys(headers).some((k) => k.toLowerCase() === 'list-unsubscribe');
  let body = html;
  let computed: Record<string, string> | undefined;
  if (gated && !callerOwnsOptOut) {
    body = withUnsubscribeFooter(html, unsubscribeFooterHtml(userId!, groupId!, locale));
    computed = unsubscribeHeaders(userId!, groupId!);
  }
  // Caller last: an explicit header beats one we derived. Note the group check
  // above still ran either way — owning the *presentation* of an opt-out is not
  // permission to ignore the recipient's stored choice.
  const mergedHeaders = { ...(computed ?? {}), ...(headers ?? {}) };

  try {
    await via.sendMail({
      from: fromHeader(fromName, transport),
      to,
      subject,
      html: body,
      text: htmlToText(body),
      ...(replyTo ? { replyTo } : {}),
      ...(attachments?.length ? { attachments } : {}),
      ...(mergedHeaders && Object.keys(mergedHeaders).length ? { headers: mergedHeaders } : {}),
    });
  } catch (e) {
    // Record, then rethrow unchanged: callers that already catch (and the ones
    // that deliberately don't) keep behaving exactly as before.
    const message = e instanceof Error ? e.message : String(e);
    logger.error('Email send failed', { to, subject, category, transport, error: message });
    await recordEmail(to, subject, category, 'FAILED', transport, message);
    void maybeAlertEmailFailures(category).catch(() => {});
    throw e;
  }

  await recordEmail(to, subject, category, 'SENT', transport);
  return 'SENT';
}

// Connectivity-only check (auth + reachability), no message sent — used by the
// opt-in `/api/health?smtp=1` probe so SMTP outages (#483) surface as a clear
// signal instead of only being visible per-user as "email never arrived".
// The bulk channel's own connectivity check. `configured: false` is not a
// failure — it means every category rides the primary transport, which is a
// valid (and the default) setup.
export async function verifyBulkSmtpConnection(): Promise<{ configured: boolean; ok: boolean; error?: string }> {
  if (!bulkTransporter) return { configured: false, ok: true };
  try {
    await bulkTransporter.verify();
    return { configured: true, ok: true };
  } catch (e) {
    return { configured: true, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// What the two channels are set to send as — shown in the admin email panel so
// the split is verifiable at a glance rather than by reading the env file.
export function mailChannelInfo() {
  return {
    primary: { host: process.env.SMTP_HOST || null, from: fromHeader(null, 'primary') || null },
    bulk: bulkTransporter
      ? { host: process.env.SMTP_BULK_HOST || null, from: fromHeader(null, 'bulk') || null }
      : null,
    bulkCategories: [...BULK_CATEGORIES],
  };
}

export async function verifySmtpConnection(): Promise<{ ok: boolean; error?: string }> {
  if (!process.env.SMTP_USER) return { ok: false, error: 'SMTP not configured' };
  try {
    await transporter.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function sendInvitationEmail({
  to,
  token,
  role,
  orgId,
}: {
  to: string;
  token: string;
  role: string;
  orgId?: string | null;
}) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const registerUrl = `${appUrl}/auth/register?token=${token}`;
  const brand = await emailBrand(orgId);

  return await sendEmail({
    to,
    fromName: brand.name,
    category: 'invitation',
    subject: `You have been invited to ${brand.name}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, `Welcome to ${brand.name}`)}
        <p>You have been invited to join as a <strong>${role}</strong>.</p>
        <p>Click the button below to complete your registration:</p>
        <a href="${registerUrl}" style="
          display: inline-block;
          background-color: ${brand.accent};
          color: white;
          padding: 12px 24px;
          text-decoration: none;
          border-radius: 6px;
          margin: 16px 0;
        ">
          Accept Invitation
        </a>
        <p style="color: #6b7280; font-size: 14px;">
          This invitation will expire in 7 days. If you did not expect this email, please ignore it.
        </p>
        <p style="color: #6b7280; font-size: 12px;">
          Or copy this link: ${registerUrl}
        </p>
      </div>
    `,
  });
}

export async function sendPasswordResetEmail({
  to,
  token,
  fullName,
  purpose = 'RESET',
  orgId,
}: {
  to: string;
  token: string;
  fullName?: string | null;
  purpose?: 'RESET' | 'SET_INITIAL';
  orgId?: string | null;
}) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const resetUrl = `${appUrl}/auth/reset?token=${token}`;
  const isInitial = purpose === 'SET_INITIAL';
  const brand = await emailBrand(orgId);

  const heading = isInitial ? 'Set your password' : 'Reset your password';
  const intro = isInitial
    ? `An account has been created for you on ${brand.name}. Set a password to activate it and sign in.`
    : 'We received a request to reset your password. Click the button below to choose a new one.';
  const cta = isInitial ? 'Set password' : 'Reset password';

  return await sendEmail({
    to,
    fromName: brand.name,
    category: 'password-reset',
    subject: isInitial ? `Activate your ${brand.name} account` : `Reset your ${brand.name} password`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, heading)}
        ${fullName ? `<p>Hi ${fullName},</p>` : ''}
        <p>${intro}</p>
        <a href="${resetUrl}" style="
          display: inline-block;
          background-color: ${brand.accent};
          color: white;
          padding: 12px 24px;
          text-decoration: none;
          border-radius: 6px;
          margin: 16px 0;
        ">
          ${cta}
        </a>
        <p style="color: #6b7280; font-size: 14px;">
          This link expires in ${isInitial ? '7 days' : '1 hour'}. If you did not expect this email, you can safely ignore it.
        </p>
        <p style="color: #6b7280; font-size: 12px;">
          Or copy this link: ${resetUrl}
        </p>
      </div>
    `,
  });
}

export async function sendVerificationEmail({
  to,
  token,
  fullName,
  orgId,
}: {
  to: string;
  token: string;
  fullName?: string | null;
  orgId?: string | null;
}) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const verifyUrl = `${appUrl}/auth/verify?token=${token}`;
  const brand = await emailBrand(orgId);

  await sendEmail({
    to,
    fromName: brand.name,
    category: 'verification',
    subject: `Verify your ${brand.name} email`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, 'Confirm your email')}
        ${fullName ? `<p>Hi ${fullName},</p>` : ''}
        <p>Please confirm your email address to activate full access to your account.</p>
        <a href="${verifyUrl}" style="
          display: inline-block;
          background-color: ${brand.accent};
          color: white;
          padding: 12px 24px;
          text-decoration: none;
          border-radius: 6px;
          margin: 16px 0;
        ">
          Verify email
        </a>
        <p style="color: #6b7280; font-size: 14px;">
          This link expires in 24 hours. Until you verify, your account has read-only access.
        </p>
        <p style="color: #6b7280; font-size: 12px;">
          Or copy this link: ${verifyUrl}
        </p>
      </div>
    `,
  });
}

export async function sendMeetingInviteEmail({
  to,
  fullName,
  title,
  scheduledAt,
  meetLink,
  rsvpToken,
  timeZone,
  organizerTimeZone,
  organizerName,
  userId,
  icsUid,
  sequence,
}: {
  to: string;
  fullName?: string | null;
  title: string;
  scheduledAt: Date | null;
  meetLink?: string | null;
  // Omitted for announcements that have no Meeting row behind them — a
  // recurring series occurrence is computed from the rule, so there is nothing
  // to RSVP against and the buttons are left out.
  rsvpToken?: string | null;
  // The recipient's saved IANA zone; falls back to the deployment default.
  timeZone?: string | null;
  // The clock the organizer picked the time on (Meeting.timeZone, #1210) and
  // whose it is. Rendered as a second line when it differs from the invitee's,
  // so both sides can confirm they agreed on the same instant.
  organizerTimeZone?: string | null;
  organizerName?: string | null;
  // The invitee's User.id when they are one, so the invite carries a working
  // per-group unsubscribe. Omitted by callers that only hold an address.
  userId?: string | null;
  // Identity of the event in the recipient's calendar (#2015). Supplying it is
  // what turns on the .ics attachment; the same value must be reused for every
  // later mail about the same meeting, or a reschedule lands as a second event
  // instead of moving the first one. Omitted by announcement-shaped callers
  // that have no single event behind them.
  icsUid?: string | null;
  // Bumped by whoever mails a change to the same icsUid — see buildMeetingIcs.
  sequence?: number;
}) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const yes = `${appUrl}/rsvp/${rsvpToken}?r=yes`;
  const no = `${appUrl}/rsvp/${rsvpToken}?r=no`;
  // A meeting with no set time is just a shared link — skip the "when" line and
  // the RSVP ask entirely.
  const when = scheduledAt ? formatInTimeZone(scheduledAt, timeZone, { dateStyle: 'full', timeStyle: 'short' }) : null;
  const askRsvp = Boolean(when && rsvpToken);
  // A link-only meeting (no scheduledAt) has no slot to occupy, so it gets no
  // attachment at all — an .ics without a DTSTART is not a thing.
  const ics = scheduledAt && icsUid ? meetingIcsAttachment({ uid: icsUid, title, start: scheduledAt, meetLink, sequence }) : null;

  await sendEmail({
    to,
    userId,
    category: 'meeting-invite',
    ...(ics ? { attachments: [ics] } : {}),
    subject: `Meeting invitation: ${title}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2563eb;">${title}</h2>
        ${fullName ? `<p>Hi ${fullName},</p>` : ''}
        <p>You're invited to a meeting.</p>
        ${when ? `<p><strong>When:</strong> ${when}</p>` : ''}
        ${when && scheduledAt ? organizerTimeLine(scheduledAt, organizerTimeZone, timeZone, organizerName) : ''}
        ${meetLink ? `<p><strong>Meeting link:</strong> <a href="${meetLink}">${meetLink}</a></p>` : ''}
        ${askRsvp ? `
        <p style="margin-top: 20px;">Can you make it?</p>
        <a href="${yes}" style="display:inline-block;background:#16a34a;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;margin-right:8px;">Yes, I'll attend</a>
        <a href="${no}" style="display:inline-block;background:#dc2626;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;">Can't attend</a>
        ` : ''}
        ${when ? timeZoneNote(timeZone) : ''}
      </div>
    `,
  });
}

// The same invitation, addressed to someone who has no account here (#1446).
//
// Kept as a sibling of sendMeetingInviteEmail rather than a flag on it, because
// three things genuinely differ for an outsider and each of them is a
// correctness bug if it leaks through:
//   - the timezone footer must NOT link to /account#timezone, a page a guest
//     cannot reach (and would be asked to sign in for);
//   - there is no saved zone to render on, so the time is printed on the
//     organizer's clock and the mail says whose clock that is;
//   - the mail has to say who invited them and to what, since an unexpected
//     invitation from an unknown system otherwise reads as spam.
export async function sendMeetingGuestInviteEmail({
  to,
  name,
  title,
  scheduledAt,
  meetLink,
  rsvpToken,
  organizerTimeZone,
  organizerName,
  icsUid,
  sequence,
}: {
  to: string;
  name?: string | null;
  title: string;
  scheduledAt: Date | null;
  meetLink?: string | null;
  rsvpToken: string;
  // The clock the organizer picked the time on (Meeting.timeZone). A guest has
  // no profile, so this — or the deployment default — is the only clock there is.
  organizerTimeZone?: string | null;
  organizerName?: string | null;
  // See sendMeetingInviteEmail. It matters most here: a guest has no account,
  // so the attachment is their only route into a calendar (#2015).
  icsUid?: string | null;
  sequence?: number;
}) {
  const url = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const yes = `${url}/rsvp/${rsvpToken}?r=yes`;
  const no = `${url}/rsvp/${rsvpToken}?r=no`;
  const zone = resolveTimeZone(organizerTimeZone);
  const when = scheduledAt
    ? `${formatInTimeZone(scheduledAt, zone, { dateStyle: 'full', timeStyle: 'short' })} (${zoneLabel(scheduledAt, zone)})`
    : null;
  const invitedBy = organizerName ? esc(organizerName) : null;
  const ics = scheduledAt && icsUid ? meetingIcsAttachment({ uid: icsUid, title, start: scheduledAt, meetLink, sequence }) : null;

  await sendEmail({
    to,
    subject: `Meeting invitation: ${title}`,
    ...(ics ? { attachments: [ics] } : {}),
    // no-user-row: a guest is an address somebody typed into the scheduler,
    // deliberately not an account here — there is no row to gate on and no
    // token to mint, and the mail says so in its own closing line instead.
    category: 'meeting-guest-invite',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2563eb;">${esc(title)}</h2>
        ${name ? `<p>Hi ${esc(name)},</p>` : ''}
        <p>${invitedBy ? `${invitedBy} has invited you` : 'You are invited'} to a meeting.</p>
        ${when ? `<p><strong>When:</strong> ${esc(when)}</p>` : ''}
        ${meetLink ? `<p><strong>Meeting link:</strong> <a href="${meetLink}">${esc(meetLink)}</a></p>` : ''}
        ${when ? `
        <p style="margin-top: 20px;">Can you make it?</p>
        <a href="${yes}" style="display:inline-block;background:#16a34a;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;margin-right:8px;">Yes, I'll attend</a>
        <a href="${no}" style="display:inline-block;background:#dc2626;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;">Can't attend</a>
        <p style="margin-top:16px;"><a href="${url}/rsvp/${rsvpToken}" style="color:#2563eb;font-size:14px;">Open the invitation</a></p>
        ` : ''}
        ${when ? `<p style="color:#9ca3af;font-size:12px;line-height:1.5;margin-top:20px;">
          Times in this email are shown in ${esc(zone)}${invitedBy ? ` — the clock ${invitedBy} scheduled it on` : ''}.
        </p>` : ''}
        <p style="color:#9ca3af;font-size:12px;line-height:1.5;">
          You received this because someone entered your address when scheduling this meeting.
          You do not need an account to reply — the buttons above are enough.
        </p>
      </div>
    `,
  });
}

// The calendar file that rides along with a meeting mail (#2015). METHOD:REQUEST
// is what makes a client treat it as an invitation rather than a read-only copy;
// the same header has to be repeated on the MIME part, because Outlook reads the
// content type and not the body. `.ics` generation itself stays in @/lib/ics —
// this only wraps it in the shape sendEmail's `attachments` takes.
//
// The length is buildMeetingIcs's 30-minute default: a Meeting has no stored
// duration yet (#1984). When it gains one, thread it through here.
function meetingIcsAttachment(opts: {
  uid: string;
  title: string;
  start: Date;
  meetLink?: string | null;
  sequence?: number;
}) {
  const ics = buildMeetingIcs({
    uid: opts.uid,
    title: opts.title,
    start: opts.start,
    description: opts.meetLink ? `Join: ${opts.meetLink}` : null,
    location: opts.meetLink ?? null,
    method: 'REQUEST',
    sequence: opts.sequence,
  });
  return {
    filename: 'meeting.ics',
    content: Buffer.from(ics, 'utf-8'),
    contentType: 'text/calendar; charset=utf-8; method=REQUEST',
  };
}

// Minimal HTML escape for user-supplied strings interpolated into templates
// (names, free-text messages) — keeps a stray "<" from breaking the markup.
function esc(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] as string);
}

// A branded button + wrapper shared by the notification templates below.
function ctaBlock(brand: { accent: string }, url: string, label: string): string {
  return `<a href="${url}" style="display:inline-block;background-color:${brand.accent};color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;margin:16px 0;">${label}</a>`;
}

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

// --- Which clock is this email on? (#1210) ----------------------------------

// Every emailed time is rendered on exactly one clock — the recipient's saved
// zone, or the deployment default when they have none — and until now nothing
// in the email said so. A reader whose zone was guessed wrong could not tell a
// wrong time from a wrong assumption about them, and had nowhere to go with it.
// This is the small print that closes the loop: name the zone, and link to the
// one place it can be corrected.
//
// Deliberately English like the rest of these templates: a translated footer
// under an untranslated body reads as a bug, not as a courtesy.
function timeZoneNote(timeZone?: string | null): string {
  const zone = resolveTimeZone(timeZone);
  return `<p style="color:#9ca3af;font-size:12px;line-height:1.5;margin-top:20px;">
    Times in this email are shown in ${esc(zone)}. Not your timezone?
    <a href="${appUrl()}/account#timezone" style="color:#9ca3af;text-decoration:underline;">Change it in your settings</a>.
  </p>`;
}

// The second reading: the clock the organizer set the time on. Printed only when
// it is a genuinely different clock — an organizer in Berlin and an invitee in
// Paris read the identical time, and repeating it would be noise, not
// confirmation. `sameWallClock` compares offsets *at this instant*, so two zones
// that agree today and diverge across a DST change are handled correctly.
function organizerTimeLine(
  at: Date,
  organizerTimeZone: string | null | undefined,
  recipientTimeZone: string | null | undefined,
  organizerName?: string | null
): string {
  if (!organizerTimeZone || sameWallClock(organizerTimeZone, recipientTimeZone, at)) return '';
  const who = organizerName ? `${esc(organizerName)}’s time` : 'Organizer’s time';
  return `<p style="color:#6b7280;font-size:14px;">${who}: ${formatInTimeZone(at, organizerTimeZone, { dateStyle: 'medium', timeStyle: 'short' })}</p>`;
}

// The same instant on everyone *else's* clock — one line per distinct clock, so
// a five-person project meeting spanning three zones prints three lines and not
// five. Only zones that actually differ from the reader's are listed: telling
// someone in Istanbul that it is also 17:00 in Istanbul for two colleagues adds
// nothing. Empty when the whole team reads the same time, which is the common
// case and should stay silent.
function participantClocks(at: Date, viewerTimeZone: string | null | undefined, others: ZonedPerson[]): string {
  const elsewhere = others.filter((p) => !sameWallClock(p.timezone, viewerTimeZone, at));
  if (elsewhere.length === 0) return '';
  const rows = readingsByZone(at, elsewhere)
    .map((r) => `<li>${esc(r.names.join(', '))} — ${esc(r.when)} (${esc(r.offsetLabel)})</li>`)
    .join('');
  return `<p style="color:#6b7280;font-size:14px;margin-bottom:4px;">For the others:</p>
    <ul style="color:#6b7280;font-size:14px;margin-top:0;padding-left:20px;">${rows}</ul>`;
}

// --- Mentorship request lifecycle (#668) ------------------------------------
// These events previously produced an in-app notification only, so a mentee who
// wasn't logged in never learned their request had been decided.

export async function sendMentorshipDecisionEmail({
  to,
  fullName,
  approved,
  mentorName,
  orgId,
  userId,
}: {
  to: string;
  fullName?: string | null;
  approved: boolean;
  mentorName?: string | null;
  orgId?: string | null;
  userId?: string | null;
}) {
  const brand = await emailBrand(orgId);
  const heading = approved ? 'Your mentorship request was approved' : 'Update on your mentorship request';
  const body = approved
    ? `<p>Good news — your mentorship request has been approved${mentorName ? ` and <strong>${esc(mentorName)}</strong> is now your mentor` : ''}. Open your portal to say hi and get started.</p>`
    : `<p>Your mentorship request has been reviewed, but it could not be approved right now. You are welcome to submit a new request later — keeping your profile and CV up to date helps.</p>`;

  await sendEmail({
    to,
    userId,
    category: 'mentorship-decision',
    fromName: brand.name,
    subject: approved ? `Your mentorship request was approved` : `Update on your mentorship request`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, heading)}
        ${fullName ? `<p>Hi ${esc(fullName)},</p>` : ''}
        ${body}
        ${ctaBlock(brand, `${appUrl()}/portal`, 'Open your portal')}
      </div>
    `,
  });
}

export async function sendMenteeAssignedEmail({
  to,
  mentorName,
  menteeName,
  orgId,
  userId,
}: {
  to: string;
  mentorName?: string | null;
  menteeName: string;
  orgId?: string | null;
  userId?: string | null;
}) {
  const brand = await emailBrand(orgId);
  await sendEmail({
    to,
    userId,
    category: 'mentee-assigned',
    fromName: brand.name,
    subject: `New mentee assigned: ${menteeName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, 'You have a new mentee')}
        ${mentorName ? `<p>Hi ${esc(mentorName)},</p>` : ''}
        <p><strong>${esc(menteeName)}</strong> has been assigned to you as a mentee. Reach out to
        them to get the mentorship started, and log your first interaction when you do.</p>
        ${ctaBlock(brand, `${appUrl()}/mentor`, 'Open your dashboard')}
      </div>
    `,
  });
}

// An admin wiring up a mentorship directly (no prior mentee request, #668) —
// the mentee never asked, so the request-approval copy would not fit.
export async function sendMentorAssignedEmail({
  to,
  menteeName,
  mentorName,
  orgId,
  userId,
}: {
  to: string;
  menteeName?: string | null;
  mentorName: string;
  orgId?: string | null;
  userId?: string | null;
}) {
  const brand = await emailBrand(orgId);
  await sendEmail({
    to,
    userId,
    category: 'mentor-assigned',
    fromName: brand.name,
    subject: `You have a mentor: ${mentorName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, 'You have been assigned a mentor')}
        ${menteeName ? `<p>Hi ${esc(menteeName)},</p>` : ''}
        <p><strong>${esc(mentorName)}</strong> is now your mentor. Open your portal to say hi
        and get the mentorship started.</p>
        ${ctaBlock(brand, `${appUrl()}/portal`, 'Open your portal')}
      </div>
    `,
  });
}

export async function sendMentorshipRequestEmail({
  to,
  adminName,
  menteeName,
  targetPosition,
  message,
  orgId,
  userId,
}: {
  to: string;
  adminName?: string | null;
  menteeName: string;
  targetPosition?: string | null;
  message?: string | null;
  orgId?: string | null;
  userId?: string | null;
}) {
  const brand = await emailBrand(orgId);
  await sendEmail({
    to,
    userId,
    category: 'mentorship-request',
    fromName: brand.name,
    subject: `New mentorship request: ${menteeName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, 'New mentorship request')}
        ${adminName ? `<p>Hi ${esc(adminName)},</p>` : ''}
        <p><strong>${esc(menteeName)}</strong> asked to be matched with a mentor${targetPosition ? ` (target position: ${esc(targetPosition)})` : ''}.</p>
        ${message ? `<blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#444;">${esc(message)}</blockquote>` : ''}
        ${ctaBlock(brand, `${appUrl()}/admin/mentorship`, 'Review the request')}
      </div>
    `,
  });
}

// --- Mentor applications (#904/#905/#933) -----------------------------------
// The only transactional emails in this file localized to the recipient: the
// applicant is never a signed-in User with an account-level language, so the
// `locale` captured on submit (src/app/apply-as-mentor/page.tsx) is all we have.
function resolveLocale(locale?: string | null): Locale {
  return isLocale(locale ?? undefined) ? (locale as Locale) : defaultLocale;
}

export async function sendMentorApplicationReceivedEmail({
  to,
  fullName,
  locale,
  orgId,
}: {
  to: string;
  fullName: string;
  locale?: string | null;
  orgId?: string | null;
}) {
  const brand = await emailBrand(orgId);
  const M = getDictionary(resolveLocale(locale)).mentorApplicationEmail;
  await sendEmail({
    to,
    // no-user-row: the applicant is a MentorApplication and nothing else yet —
    // no User row exists to hold a preference, so there is nothing to
    // unsubscribe and no footer is emitted (see `userId` in sendEmail).
    category: 'mentor-application-received',
    locale,
    fromName: brand.name,
    subject: M.received.subject,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, M.received.heading)}
        <p>${esc(M.greeting.replace('{name}', fullName))}</p>
        <p>${esc(M.received.body)}</p>
      </div>
    `,
  });
}

export async function sendMentorApplicationUnderReviewEmail({
  to,
  fullName,
  locale,
  orgId,
}: {
  to: string;
  fullName: string;
  locale?: string | null;
  orgId?: string | null;
}) {
  const brand = await emailBrand(orgId);
  const M = getDictionary(resolveLocale(locale)).mentorApplicationEmail;
  await sendEmail({
    to,
    // no-user-row: same recipient as the acknowledgement above — an application
    // under review still has no account behind it, so there is no preference to
    // read and no unsubscribe token to mint.
    category: 'mentor-application-received',
    locale,
    fromName: brand.name,
    subject: M.underReview.subject,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, M.underReview.heading)}
        <p>${esc(M.greeting.replace('{name}', fullName))}</p>
        <p>${esc(M.underReview.body)}</p>
      </div>
    `,
  });
}

// `registerUrl` set → no account existed yet, an invitation token was created
// (mirrors sendInvitationEmail's link). Omitted → an existing account was
// promoted to MENTOR in place, so the CTA is just "sign in".
export async function sendMentorApplicationApprovedEmail({
  to,
  fullName,
  locale,
  orgId,
  registerUrl,
  userId,
}: {
  to: string;
  fullName: string;
  locale?: string | null;
  orgId?: string | null;
  registerUrl?: string | null;
  // Set only on the "existing account promoted in place" path — the invited
  // path has no User row yet, so that copy ships without a footer. The invited
  // caller carries the `no-user-row:` marker itself: a marker here would exempt
  // every call site of this sender at once, including the promoted one, which is
  // the opposite of what the scan is for.
  userId?: string | null;
}) {
  const brand = await emailBrand(orgId);
  const M = getDictionary(resolveLocale(locale)).mentorApplicationEmail;
  const isNewAccount = !!registerUrl;
  await sendEmail({
    to,
    userId,
    category: 'mentor-application',
    locale,
    fromName: brand.name,
    subject: M.approved.subject,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, M.approved.heading)}
        <p>${esc(M.greeting.replace('{name}', fullName))}</p>
        <p>${esc(isNewAccount ? M.approved.bodyNewAccount : M.approved.bodyExistingAccount)}</p>
        ${ctaBlock(brand, registerUrl || `${appUrl()}/auth/signin`, isNewAccount ? M.approved.ctaRegister : M.approved.ctaSignIn)}
      </div>
    `,
  });
}

// The rejection *reason* an admin records is internal-only (never sent here) —
// the applicant gets a generic, kind decline instead.
export async function sendMentorApplicationRejectedEmail({
  to,
  fullName,
  locale,
  orgId,
}: {
  to: string;
  fullName: string;
  locale?: string | null;
  orgId?: string | null;
}) {
  const brand = await emailBrand(orgId);
  const M = getDictionary(resolveLocale(locale)).mentorApplicationEmail;
  await sendEmail({
    to,
    // no-user-row: a declined application never became a User row, so there is
    // nothing to unsubscribe from — and this is the last mail it will ever
    // produce, which is the one case where that is self-evidently fine.
    category: 'mentor-application',
    locale,
    fromName: brand.name,
    subject: M.rejected.subject,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, M.rejected.heading)}
        <p>${esc(M.greeting.replace('{name}', fullName))}</p>
        <p>${esc(M.rejected.body)}</p>
      </div>
    `,
  });
}

// --- Offers (#809) -----------------------------------------------------------

function formatOfferDate(d: Date | null | undefined, locale: Locale): string | null {
  if (!d) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(d);
}

export async function sendOfferSentEmail({
  to,
  fullName,
  position,
  companyName,
  startDate,
  expiresAt,
  locale,
  orgId,
  userId,
}: {
  to: string;
  fullName: string;
  position: string;
  companyName?: string | null;
  startDate?: Date | null;
  expiresAt?: Date | null;
  locale?: string | null;
  orgId?: string | null;
  userId?: string | null;
}) {
  const brand = await emailBrand(orgId);
  const loc = resolveLocale(locale);
  const M = getDictionary(loc).offerEmail;
  const start = formatOfferDate(startDate, loc);
  const expires = formatOfferDate(expiresAt, loc);
  await sendEmail({
    to,
    userId,
    category: 'offer',
    locale,
    fromName: brand.name,
    subject: M.sent.subject.replace('{position}', position),
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, M.sent.heading)}
        <p>${esc(M.greeting.replace('{name}', fullName))}</p>
        <p>${esc(M.sent.body.replace('{position}', position).replace('{company}', companyName ? ` (${companyName})` : ''))}</p>
        ${start ? `<p><strong>${esc(M.startDate)}:</strong> ${esc(start)}</p>` : ''}
        ${expires ? `<p><strong>${esc(M.decideBy)}:</strong> ${esc(expires)}</p>` : ''}
        ${ctaBlock(brand, `${appUrl()}/portal`, M.sent.cta)}
      </div>
    `,
  });
}

export async function sendOfferDecisionEmail({
  to,
  fullName,
  menteeName,
  position,
  outcome,
  locale,
  orgId,
  userId,
}: {
  to: string;
  fullName: string;
  menteeName: string;
  position: string;
  outcome: 'ACCEPTED' | 'DECLINED' | 'EXPIRED';
  locale?: string | null;
  orgId?: string | null;
  userId?: string | null;
}) {
  const brand = await emailBrand(orgId);
  const M = getDictionary(resolveLocale(locale)).offerEmail;
  const copy = outcome === 'ACCEPTED' ? M.accepted : outcome === 'DECLINED' ? M.declined : M.expired;
  await sendEmail({
    to,
    userId,
    category: 'offer',
    locale,
    fromName: brand.name,
    subject: copy.subject.replace('{mentee}', menteeName),
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, copy.heading)}
        <p>${esc(M.greeting.replace('{name}', fullName))}</p>
        <p>${esc(copy.body.replace('{mentee}', menteeName).replace('{position}', position))}</p>
        ${ctaBlock(brand, `${appUrl()}/admin/candidates`, M.cta)}
      </div>
    `,
  });
}

// Account role converted by an admin (#1252). Deliberately NOT gated on
// emailAllowed(): the conversion signs the person out of every device — an
// account-level notice like a password reset, not an opt-out-able digest.
export async function sendRoleChangeEmail({
  to,
  fullName,
  newRole,
  locale,
  orgId,
}: {
  to: string;
  fullName: string;
  newRole: 'MENTOR' | 'MENTEE';
  locale?: string | null;
  orgId?: string | null;
}) {
  const brand = await emailBrand(orgId);
  const M = getDictionary(resolveLocale(locale)).roleChangeEmail;
  const mentor = newRole === 'MENTOR';
  await sendEmail({
    to,
    fromName: brand.name,
    subject: mentor ? M.subjectMentor : M.subjectMentee,
    category: 'account',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, mentor ? M.headingMentor : M.headingMentee)}
        <p>${esc(M.greeting.replace('{name}', fullName))}</p>
        <p>${esc(mentor ? M.bodyMentor : M.bodyMentee)}</p>
        ${ctaBlock(brand, `${appUrl()}/auth/signin`, M.cta)}
      </div>
    `,
  });
}

// --- Meeting requests (#668) ------------------------------------------------

export async function sendMeetingRequestEmail({
  to,
  fullName,
  requesterName,
  topic,
  proposedAt,
  link,
  orgId,
  timeZone,
  requesterTimeZone,
  userId,
}: {
  to: string;
  fullName?: string | null;
  requesterName: string;
  topic: string;
  proposedAt: Date | null;
  link: string;
  orgId?: string | null;
  timeZone?: string | null;
  // The clock the requester proposed on. Worth naming here above all: the
  // mentor is being asked to agree to a time somebody else picked (#1210).
  requesterTimeZone?: string | null;
  userId?: string | null;
}) {
  const brand = await emailBrand(orgId);
  const when = proposedAt ? formatInTimeZone(proposedAt, timeZone, { dateStyle: 'full', timeStyle: 'short' }) : null;
  await sendEmail({
    to,
    userId,
    category: 'meeting-request',
    fromName: brand.name,
    subject: `Meeting request: ${topic}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, 'New meeting request')}
        ${fullName ? `<p>Hi ${esc(fullName)},</p>` : ''}
        <p><strong>${esc(requesterName)}</strong> requested a meeting: <strong>${esc(topic)}</strong>.</p>
        ${when ? `<p><strong>Proposed time:</strong> ${when}</p>` : ''}
        ${when && proposedAt ? organizerTimeLine(proposedAt, requesterTimeZone, timeZone, requesterName) : ''}
        ${ctaBlock(brand, `${appUrl()}${link}`, 'Accept or decline')}
        ${when ? timeZoneNote(timeZone) : ''}
      </div>
    `,
  });
}

export async function sendMeetingRequestDecisionEmail({
  to,
  fullName,
  topic,
  accepted,
  scheduledAt,
  meetLink,
  link,
  orgId,
  timeZone,
  userId,
}: {
  to: string;
  fullName?: string | null;
  topic: string;
  accepted: boolean;
  scheduledAt?: Date | null;
  meetLink?: string | null;
  link: string;
  orgId?: string | null;
  timeZone?: string | null;
  userId?: string | null;
}) {
  const brand = await emailBrand(orgId);
  const when = scheduledAt ? formatInTimeZone(scheduledAt, timeZone, { dateStyle: 'full', timeStyle: 'short' }) : null;
  await sendEmail({
    to,
    userId,
    category: 'meeting-request-decision',
    fromName: brand.name,
    subject: accepted ? `Meeting confirmed: ${topic}` : `Meeting request declined: ${topic}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, accepted ? 'Your meeting is confirmed' : 'Your meeting request was declined')}
        ${fullName ? `<p>Hi ${esc(fullName)},</p>` : ''}
        ${accepted
          ? `<p>Your meeting request <strong>${esc(topic)}</strong> was accepted.</p>
             ${when ? `<p><strong>When:</strong> ${when}</p>` : ''}
             ${meetLink ? `<p><strong>Meeting link:</strong> <a href="${meetLink}">${meetLink}</a></p>` : ''}`
          : `<p>Your meeting request <strong>${esc(topic)}</strong> could not be accepted. You can propose another time.</p>`}
        ${ctaBlock(brand, `${appUrl()}${link}`, 'Open the conversation')}
        ${when ? timeZoneNote(timeZone) : ''}
      </div>
    `,
  });
}

// --- Public profile contact form (#668) -------------------------------------
// An outside enquiry (e.g. a recruiter) is the most time-sensitive thing a
// profile owner can receive, and it was in-app only. Reply-To is set to the
// sender so the owner can answer straight from their inbox.

export async function sendPublicContactEmail({
  to,
  ownerName,
  fromName,
  fromEmail,
  message,
  orgId,
  userId,
}: {
  to: string;
  ownerName?: string | null;
  fromName: string;
  fromEmail: string;
  message: string;
  orgId?: string | null;
  userId?: string | null;
}) {
  const brand = await emailBrand(orgId);
  await sendEmail({
    to,
    userId,
    category: 'public-contact',
    fromName: brand.name,
    replyTo: fromEmail,
    subject: `New message from your public profile: ${fromName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, 'Someone contacted you')}
        ${ownerName ? `<p>Hi ${esc(ownerName)},</p>` : ''}
        <p><strong>${esc(fromName)}</strong> (${esc(fromEmail)}) sent you a message through your public profile:</p>
        <blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#444;">${esc(message).replace(/\n/g, '<br>')}</blockquote>
        <p style="color:#6b7280;font-size:14px;">Reply to this email to answer them directly.</p>
      </div>
    `,
  });
}

// A company enquiry from the public /for-companies page, mailed to every admin.
// Reply-To is the company's address, so answering is one click — this is the
// most time-sensitive thing the public site produces.
export async function sendCompanyInquiryEmail({
  to,
  adminName,
  companyName,
  contactName,
  fromEmail,
  phone,
  openRoles,
  message,
  locale,
  orgId,
  userId,
}: {
  to: string;
  adminName?: string | null;
  companyName: string;
  contactName: string;
  fromEmail: string;
  phone?: string | null;
  openRoles?: string | null;
  message?: string | null;
  locale?: string | null;
  orgId?: string | null;
  userId?: string | null;
}) {
  const brand = await emailBrand(orgId);
  const M = getDictionary(resolveLocale(locale)).companyInquiryEmail;
  await sendEmail({
    to,
    userId,
    category: 'company-inquiry',
    locale,
    fromName: brand.name,
    replyTo: fromEmail,
    subject: `${M.subject}: ${companyName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, M.heading)}
        ${adminName ? `<p>${esc(M.greeting.replace('{name}', adminName))}</p>` : ''}
        <p><strong>${esc(companyName)}</strong> — ${esc(contactName)} (${esc(fromEmail)})</p>
        ${phone ? `<p>${esc(M.phone)}: ${esc(phone)}</p>` : ''}
        ${openRoles ? `<p>${esc(M.openRoles)}: ${esc(openRoles)}</p>` : ''}
        ${message ? `<blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#444;">${esc(message).replace(/\n/g, '<br>')}</blockquote>` : ''}
        <p style="color:#6b7280;font-size:14px;">${esc(M.replyHint)}</p>
      </div>
    `,
  });
}

// --- Project join requests (#51) --------------------------------------------

export async function sendProjectJoinRequestEmail({
  to,
  fullName,
  projectId,
  projectName,
  requesterName,
  message,
  recipient,
  orgId,
  userId,
}: {
  to: string;
  fullName?: string | null;
  projectId: string;
  projectName: string;
  requesterName: string;
  message?: string | null;
  // Preferences are honoured here rather than at the call site so no caller can
  // forget: this is an inbound request (someone wants in), group
  // inbound_requests.
  recipient: { emailNotifications?: boolean | null; notificationPrefs?: unknown };
  orgId?: string | null;
  userId?: string | null;
}) {
  // One conjunct, on this mail's own group: 'project-join-request' is
  // inbound_requests. The legacy 'mentorship' check that used to stand alongside
  // it maps to mentorship_lifecycle, a different group, so it silently dropped
  // mail that both preference surfaces reported as enabled. 'mentorship' is now
  // listed in inbound_requests.legacy, which is where an old opt-out belongs:
  // honoured, displayed, and overridable by an explicit opt-in (see the note on
  // `legacy` in src/lib/emailGroups.ts).
  if (!to || !emailGroupAllowedForCategory(recipient, 'project-join-request')) return;
  const brand = await emailBrand(orgId);
  await sendEmail({
    to,
    userId,
    category: 'project-join-request',
    fromName: brand.name,
    subject: `Join request: ${requesterName} → ${projectName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, 'Someone wants to join your project')}
        ${fullName ? `<p>Hi ${esc(fullName)},</p>` : ''}
        <p><strong>${esc(requesterName)}</strong> asked to join <strong>${esc(projectName)}</strong>.</p>
        ${message ? `<blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#444;">${esc(message).replace(/\n/g, '<br>')}</blockquote>` : ''}
        ${ctaBlock(brand, `${appUrl()}/projects/${projectId}`, 'Review the request')}
      </div>
    `,
  });
}

export async function checkMentorInteractionReminders() {
  const days = parseInt(await getSetting('reminderDays'), 10) || 14;
  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - days);

  const activeRelations = await prisma.mentorshipRelation.findMany({
    where: { status: 'ACTIVE' },
    include: {
      mentor: true,
      mentee: true,
      interactions: {
        orderBy: { date: 'desc' },
        take: 1,
      },
    },
  });

  const remindersToSend: typeof activeRelations = [];

  // People who signed up, got their first message and were never heard from
  // again would otherwise be reminded about daily, forever. The mentor already
  // did their part there, so they are dropped from this nudge exactly as they
  // are dropped from the in-app attention queue (see lib/dormantFirstContact.ts).
  const dormant = await findDormantFirstContacts(
    activeRelations.map((relation) => ({
      id: relation.id,
      orgId: relation.orgId,
      menteeId: relation.menteeId,
      pipelineStatus: relation.pipelineStatus,
      stageDeadline: relation.stageDeadline,
      lastInteractionAt: relation.interactions[0]?.date ?? null,
    })),
  );

  for (const relation of activeRelations) {
    if (dormant.has(relation.id)) continue;
    const lastInteraction = relation.interactions[0];
    const stale = !lastInteraction || lastInteraction.date < fourteenDaysAgo;
    if (stale) {
      remindersToSend.push(relation);
      // In-app notification once per staleness episode (#573): only when we
      // haven't already flagged this stretch of inactivity. In-app bell items
      // are always created (consistent with deadline/retention notifications);
      // email opt-out is handled separately below.
      if (!relation.stalenessReminderSentAt) {
        await notify(
          relation.mentorId,
          'stale_mentee.noContact',
          { menteeName: relation.mentee.fullName },
          `/mentor/mentees/${relation.id}`
        );
        await prisma.mentorshipRelation.update({
          where: { id: relation.id },
          data: { stalenessReminderSentAt: new Date() },
        });
      }
    } else if (relation.stalenessReminderSentAt) {
      // Mentee is active again — clear the flag so a future staleness episode
      // re-notifies the mentor.
      await prisma.mentorshipRelation.update({
        where: { id: relation.id },
        data: { stalenessReminderSentAt: null },
      });
    }
  }

  // One email per MENTOR, not per relation. This job runs daily, so a mentor
  // with 7 stale mentees used to get 7 separate mails every single day — and
  // unlike every other scheduled job it never consulted the recipient's
  // preferences, so there was no way to turn them off. Grouped + opt-out aware
  // ('deadlines', the same category as the stage-deadline nudge): one summary
  // listing each mentee and how long it has been.
  const byMentor = new Map<string, typeof remindersToSend>();
  for (const relation of remindersToSend) {
    const list = byMentor.get(relation.mentorId) ?? [];
    list.push(relation);
    byMentor.set(relation.mentorId, list);
  }

  let emailed = 0;
  for (const relations of byMentor.values()) {
    const mentor = relations[0].mentor;
    if (!mentor.email || !emailAllowed(mentor, 'deadlines') || !emailGroupAllowedForCategory(mentor, 'interaction-reminder')) continue;

    const rows = relations
      .map((relation) => {
        const lastDate = relation.interactions[0]?.date;
        const daysSince = lastDate
          ? Math.floor((Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24))
          : null;
        const since = daysSince !== null
          ? `${daysSince} day${daysSince === 1 ? '' : 's'} since the last interaction`
          : 'no interactions logged yet';
        return `<li style="margin-bottom:6px;"><strong>${relation.mentee.fullName}</strong> — ${since}</li>`;
      })
      .join('');

    try {
      await sendEmail({
        category: 'interaction-reminder',
        userId: mentor.id,
        to: mentor.email,
        subject: relations.length === 1
          ? `Reminder: Log interaction with ${relations[0].mentee.fullName}`
          : `Reminder: ${relations.length} mentees need an interaction log`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #2563eb;">Interaction Reminder</h2>
            <p>Hi ${mentor.fullName},</p>
            <p>These mentees have had no logged interaction for a while:</p>
            <ul style="padding-left:18px;">${rows}</ul>
            <p>Please log your recent interactions to keep the mentorship record up to date.</p>
            <a href="${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/mentor" style="
              display: inline-block;
              background-color: #2563eb;
              color: white;
              padding: 12px 24px;
              text-decoration: none;
              border-radius: 6px;
              margin: 16px 0;
            ">
              Go to Mentor Dashboard
            </a>
          </div>
        `,
      });
      emailed++;
    } catch (e) {
      console.error('checkMentorInteractionReminders email failed:', { mentorId: relations[0].mentorId, error: e });
    }
  }

  return {
    checked: activeRelations.length,
    reminded: remindersToSend.length,
    emailed,
  };
}

// Notify mentors about mentees whose current stage deadline has passed. Each
// relation is reminded once per deadline (deadlineReminderSentAt guards it).
export async function checkStageDeadlineReminders() {
  const now = new Date();
  const TERMINAL = ['HIRED_660', 'EMPLOYED_700', 'INTERNSHIP_FOUND_ELSEWHERE_800'] as const;

  const overdue = await prisma.mentorshipRelation.findMany({
    where: {
      status: 'ACTIVE',
      stageDeadline: { lt: now },
      deadlineReminderSentAt: null,
      pipelineStatus: { notIn: [...TERMINAL] },
    },
    include: {
      mentor: {
        select: {
          email: true,
          fullName: true,
          emailNotifications: true,
          notificationPrefs: true,
          preferredLanguage: true,
        },
      },
      mentee: { select: { fullName: true } },
    },
  });

  for (const rel of overdue) {
    // The in-app half respects the same 'deadlines' preference the e-mail half
    // does (#817) — opting out of deadline mail and still being pinged in-app
    // for the identical event is not a preference anyone chose.
    await notifyIfAllowed(rel.mentorId, 'deadlines', 'deadline.stagePassed', { menteeName: rel.mentee.fullName }, `/mentor/mentees/${rel.id}`);
    if (emailAllowed(rel.mentor, 'deadlines') && emailGroupAllowedForCategory(rel.mentor, 'stage-deadline')) {
      const preferredLanguage = rel.mentor.preferredLanguage ?? undefined;
      const locale = isLocale(preferredLanguage) ? preferredLanguage : defaultLocale;
      const emailText = getDictionary(locale).notifications.deadlineEmail;
      const subject = emailText.subject.replace('{mentee}', rel.mentee.fullName);
      const greeting = emailText.greeting.replace('{mentor}', rel.mentor.fullName);
      const body = emailText.body.replace('{mentee}', `<strong>${rel.mentee.fullName}</strong>`);
      await sendEmail({
        category: 'stage-deadline',
        userId: rel.mentorId,
        locale: rel.mentor.preferredLanguage,
        to: rel.mentor.email,
        subject,
        html: `<p>${greeting}</p><p>${body}</p>`,
      }).catch((error) => {
        console.error('checkStageDeadlineReminders email failed:', { relationId: rel.id, mentorId: rel.mentorId, error });
      });
    }
    await prisma.mentorshipRelation.update({ where: { id: rel.id }, data: { deadlineReminderSentAt: now } });
  }

  return { reminded: overdue.length };
}

// Friday reminder for the current UTC week. The unique relation/week claim is
// created before either channel is sent, so overlapping cron runs cannot send
// the same reminder twice.
export async function sendWeeklyReportReminders(now = new Date()) {
  const weekStart = utcWeekStart(now);
  const relations = await prisma.mentorshipRelation.findMany({
    where: {
      status: 'ACTIVE', pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450', mentee: { isActive: true },
      weeklyReports: { none: { weekStart, status: { in: [...SUBMITTED_WEEKLY_REPORT_STATUSES] } } },
    },
    select: {
      id: true, orgId: true,
      mentee: { select: { id: true, fullName: true, email: true, preferredLanguage: true, emailNotifications: true, notificationPrefs: true } },
    },
  });
  if (relations.length === 0) return { checked: 0, reminded: 0, emailed: 0 };
  const claims = relations.map((relation) => ({ id: randomUUID(), relationId: relation.id, weekStart }));
  await prisma.weeklyReportReminder.createMany({ data: claims, skipDuplicates: true });
  const claimedIds = new Set((await prisma.weeklyReportReminder.findMany({ where: { id: { in: claims.map((claim) => claim.id) } }, select: { relationId: true } })).map((claim) => claim.relationId));
  let reminded = 0;
  let emailed = 0;
  for (const relation of relations) {
    if (!claimedIds.has(relation.id)) continue;
    const preferredLanguage = relation.mentee.preferredLanguage ?? undefined;
    const locale = isLocale(preferredLanguage) ? preferredLanguage : defaultLocale;
    const copy = getDictionary(locale).weeklyReports;
    const formattedWeek = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(weekStart);
    if (notificationCategoryAllowed(relation.mentee, 'weeklyReports')) {
      await notify(relation.mentee.id, 'weekly_report_reminder.due', {}, '/portal');
    }
    reminded++;
    if (emailAllowed(relation.mentee, 'weeklyReports') && emailGroupAllowedForCategory(relation.mentee, 'weekly-report')) {
      const brand = await emailBrand(relation.orgId);
      await sendEmail({
        to: relation.mentee.email, fromName: brand.name, category: 'weekly-report', subject: copy.reminderSubject,
        userId: relation.mentee.id, locale: relation.mentee.preferredLanguage,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">${brandHeader(brand, copy.reminderHeading)}<p>${copy.reminderGreeting.replace('{name}', esc(relation.mentee.fullName))}</p><p>${copy.reminderBody.replace('{date}', formattedWeek)}</p>${ctaBlock(brand, `${appUrl()}/portal`, copy.reminderCta)}</div>`,
      }).then(() => { emailed++; }).catch((error) => logger.error('Weekly report reminder email failed', { relationId: relation.id, error: String(error) }));
    }
  }
  return { checked: relations.length, reminded, emailed };
}

/**
 * "Are you still interested?" — the check-in for dormant first contacts (#1508).
 *
 * A lot of people register, get one message and are never heard from again.
 * lib/dormantFirstContact.ts drops them from the mentor's queue precisely so
 * nobody keeps chasing them by hand; this is the other half of that bargain —
 * the system asks them itself, twice, and then stops. Twice is the whole
 * budget: a third mail to somebody who has ignored two is not persistence, it
 * is what gets a sending domain marked as spam, and the cost of that is borne
 * by every meeting invitation and password reset the product sends.
 *
 * The cadence is day 14 and day 45. The first is anchored on `dormantSince`,
 * which the sweep only stamps once the outreach is already DORMANT_GRACE_DAYS
 * (14) old — so being flagged IS being due, and the job never has to re-derive
 * when the mentor last reached out. (It must not: an outreach is often an
 * in-app message rather than a logged interaction, and reading only the
 * interaction log is exactly the bug that left a mentee who had been written to
 * four times sitting in the queue.) The second is measured from the FIRST
 * NUDGE rather than from the outreach, which is what keeps the backlog sane: on
 * the day this ships, everybody whose outreach was months ago is due for nudge
 * one, and an outreach-anchored second nudge would follow it the very next
 * morning.
 *
 * No in-app notification: the entire premise is a person who does not sign in.
 * The mail is the only channel that can reach them, and a bell item nobody will
 * ever look at is not a second attempt.
 */
// No DORMANT_FIRST_NUDGE_DAYS here: the first nudge's timing is DORMANT_GRACE_DAYS
// in lib/dormantFirstContact.ts, spent before the flag is even stamped. Two
// constants for one delay is how they drift apart.
export const DORMANT_SECOND_NUDGE_GAP_DAYS = 31;
export const DORMANT_MAX_NUDGES = 2;
// A ceiling on one tick, not on the feature: the first run after this ships
// faces the whole accumulated backlog at once, and a few hundred near-identical
// mails leaving in one minute is exactly the shape of traffic that gets a
// domain throttled. The remainder simply goes out on the following days.
export const DORMANT_NUDGE_MAX_PER_RUN = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

export async function sendDormantCheckIns(now = new Date()) {
  const relations = await prisma.mentorshipRelation.findMany({
    where: {
      status: 'ACTIVE',
      dormantSince: { not: null },
      dormantNudgeCount: { lt: DORMANT_MAX_NUDGES },
      mentee: { isActive: true },
    },
    select: {
      id: true,
      orgId: true,
      dormantSince: true,
      dormantNudgeCount: true,
      dormantNudgeSentAt: true,
      mentee: {
        select: { id: true, fullName: true, email: true, preferredLanguage: true, emailNotifications: true, notificationPrefs: true },
      },
    },
    // Longest-dormant first, so a capped run always drains the oldest backlog
    // rather than a random slice of it.
    orderBy: { dormantSince: 'asc' },
  });

  let sent = 0;
  let checked = 0;
  for (const relation of relations) {
    if (sent >= DORMANT_NUDGE_MAX_PER_RUN) break;
    checked += 1;
    const count = relation.dormantNudgeCount;
    if (count > 0) {
      // Every nudge after the first is spaced from the one before it.
      if (!relation.dormantNudgeSentAt) continue;
      const days = Math.floor((now.getTime() - relation.dormantNudgeSentAt.getTime()) / DAY_MS);
      if (days < DORMANT_SECOND_NUDGE_GAP_DAYS) continue;
    } else if (!relation.dormantSince || relation.dormantSince > now) {
      // Flagged is due (see the note above); a stamp in the future can only
      // come from a caller passing a `now` in the past, and is not due.
      continue;
    }

    // Preferences are read BEFORE the claim on purpose: claiming first would
    // spend an opted-out person's two-nudge budget on mail that was never sent,
    // so opting back in later would buy them silence rather than the check-in.
    if (!emailAllowed(relation.mentee, 'announcements') || !emailGroupAllowedForCategory(relation.mentee, 'dormant-check-in')) {
      continue;
    }

    // Claim before sending, guarded on the count we read: two overlapping ticks
    // (or a retried container) can then never write the same person twice. A
    // mid-send failure loses one nudge, which is the far better failure than
    // sending it again.
    const claimed = await prisma.mentorshipRelation.updateMany({
      where: { id: relation.id, dormantNudgeCount: count },
      data: { dormantNudgeCount: count + 1, dormantNudgeSentAt: now },
    });
    if (claimed.count === 0) continue;

    const locale = isLocale(relation.mentee.preferredLanguage ?? undefined)
      ? (relation.mentee.preferredLanguage as Locale)
      : defaultLocale;
    const copy = getDictionary(locale).dormantCheckIn;
    const isFinal = count + 1 >= DORMANT_MAX_NUDGES;
    const brand = await emailBrand(relation.orgId);
    await sendEmail({
      to: relation.mentee.email,
      fromName: brand.name,
      category: 'dormant-check-in',
      userId: relation.mentee.id,
      locale: relation.mentee.preferredLanguage,
      subject: copy.subject,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">${brandHeader(brand, copy.heading)}<p>${copy.greeting.replace('{name}', esc(relation.mentee.fullName))}</p><p>${isFinal ? copy.finalBody : copy.firstBody}</p><p style="color:#666;font-size:13px;">${copy.hint}</p>${ctaBlock(brand, `${appUrl()}/portal`, copy.cta)}</div>`,
    })
      .then(() => { sent += 1; })
      .catch((error) => logger.error('Dormant check-in email failed', { relationId: relation.id, error: String(error) }));
  }

  return { checked, sent };
}

// How far ahead a meeting reminder fires. The cron ticks every 15 minutes
// (see initCronJobs), so a meeting is reminded 45-60 minutes before it starts —
// close enough to "one hour before" to be useful, and never late.
export const MEETING_REMINDER_WINDOW_MINUTES = 60;

// Reminders for meetings starting within the next ~60 minutes that haven't been
// reminded yet (#777).
//
//   • in-app: EVERY participant (mentee *and* mentor) is notified, always —
//     bell items are not subject to the email category opt-outs.
//   • email: only participants whose 'meetingReminders' category is on.
//
// Idempotency: `reminderSentAt` is claimed *before* anything is sent, with a
// `reminderSentAt: null` guard so an overlapping cron tick can't double-send.
// Marking first means a mid-send failure loses a reminder rather than
// duplicating one — the far less annoying failure mode, and it keeps the in-app
// notification and the email behind the same single marker.
export async function sendMeetingReminders() {
  const now = new Date();
  const horizon = new Date(now.getTime() + MEETING_REMINDER_WINDOW_MINUTES * 60 * 1000);
  const participantSelect = {
    id: true,
    email: true,
    fullName: true,
    role: true,
    orgId: true,
    emailNotifications: true,
    notificationPrefs: true,
    timezone: true,
  } as const;

  const meetings = await prisma.meeting.findMany({
    // `seriesId: null` — a recurring project meeting is reminded by
    // sendProjectMeetingSeriesReminders(), which covers the whole project team
    // rather than only the two sides of a relation. Without this exclusion the
    // people who have both a relation and a membership got the hour-before
    // reminder twice (#51).
    // `relationId: { not: null }` — a project/conversation meeting (#1051) has
    // no two-sided relation to remind; those rooms are instant and time-less,
    // so they never match the scheduledAt window either.
    where: {
      scheduledAt: { gt: now, lte: horizon },
      reminderSentAt: null,
      seriesId: null,
      relationId: { not: null },
    },
    include: {
      relation: {
        include: {
          mentee: { select: participantSelect },
          mentor: { select: participantSelect },
        },
      },
      // External guests (#1446). Without this an outsider gets the invitation
      // and then silence — and unlike a participant they have no dashboard, no
      // in-app notification and no calendar feed to fall back on, so the
      // reminder email is the *only* nudge they can get.
      guests: { select: { email: true, name: true, rsvp: true } },
    },
  });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  let reminded = 0;
  let notified = 0;
  let emailed = 0;

  for (const m of meetings) {
    // Guaranteed by the query above; the guard is what tells TypeScript so.
    if (!m.relation) continue;
    // Claim it first — see the idempotency note above.
    const claim = await prisma.meeting.updateMany({
      where: { id: m.id, reminderSentAt: null },
      data: { reminderSentAt: new Date() },
    });
    if (claim.count === 0) continue;
    reminded++;

    const minutes = Math.max(1, Math.round((m.scheduledAt!.getTime() - Date.now()) / 60000));

    // Both sides of the relation are participants. Series-generated meetings
    // (seriesId set) carry the same relation, so they need no special casing.
    const participants = [m.relation.mentee, m.relation.mentor].filter(
      (u, i, all) => u && all.findIndex((o) => o?.id === u.id) === i
    );

    for (const user of participants) {
      const link = user.id === m.relation.mentorId ? '/mentor/meetings' : '/portal/calendar';
      // Per participant: the two sides of a relation can sit in different zones,
      // and each must read the time on their own clock (#1030).
      const when = formatInTimeZone(m.scheduledAt!, user.timezone);
      // In-app: unconditional (notify() never throws).
      await notify(
        user.id,
        'meeting_reminder.startingSoon',
        { title: m.title, minutes, when },
        link
      );
      notified++;

      if (!user.email || !emailAllowed(user, 'meetingReminders') || !emailGroupAllowedForCategory(user, 'meeting-reminder')) continue;
      try {
        const brand = await emailBrand(user.orgId);
        await sendEmail({
          category: 'meeting-reminder',
          userId: user.id,
          to: user.email,
          fromName: brand.name,
          subject: `Reminder: ${m.title} starts soon`,
          html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            ${brandHeader(brand, 'Upcoming meeting')}
            <p>Hi ${esc(user.fullName ?? '')}, this is a reminder for <strong>${esc(m.title)}</strong>.</p>
            <p><strong>When:</strong> ${when} (in about ${minutes} minute${minutes === 1 ? '' : 's'})</p>
            ${participantClocks(
              m.scheduledAt!,
              user.timezone,
              participants.filter((p) => p.id !== user.id).map((p) => ({ name: p.fullName, timezone: p.timezone }))
            )}
            ${m.meetLink ? `<p><strong>Meeting link:</strong> <a href="${m.meetLink}">${esc(m.meetLink)}</a></p>` : ''}
            ${ctaBlock(brand, `${appUrl}${link}`, 'Open the app')}
            ${timeZoneNote(user.timezone)}
          </div>`,
        });
        emailed++;
      } catch (e) {
        // Swallowed on purpose: a bad address or an SMTP hiccup must not stop
        // the remaining participants (or meetings) from being reminded.
        console.error('Meeting reminder email failed:', e);
      }
    }

    // Guests, after the participants. No notify() — there is no userId — and no
    // emailAllowed() — there are no notificationPrefs to consult. Someone who
    // already declined is left alone: they answered, and a reminder for a
    // meeting you said no to reads as not having been listened to.
    for (const guest of m.guests) {
      if (guest.rsvp === 'DECLINED') continue;
      try {
        await sendMeetingGuestReminderEmail({
          to: guest.email,
          name: guest.name,
          title: m.title,
          scheduledAt: m.scheduledAt!,
          meetLink: m.meetLink,
          organizerTimeZone: m.timeZone,
          minutes,
        });
        emailed++;
      } catch (e) {
        console.error('Meeting guest reminder email failed:', e);
      }
    }
  }
  return { checked: meetings.length, reminded, notified, emailed };
}

// The reminder half of sendMeetingGuestInviteEmail — same reasons for being a
// sibling rather than a flag: no /account link a guest could use, the
// organizer's clock instead of a saved zone they don't have, and a line saying
// why this arrived at all.
async function sendMeetingGuestReminderEmail({
  to,
  name,
  title,
  scheduledAt,
  meetLink,
  organizerTimeZone,
  minutes,
}: {
  to: string;
  name?: string | null;
  title: string;
  scheduledAt: Date;
  meetLink?: string | null;
  organizerTimeZone?: string | null;
  minutes: number;
}) {
  const zone = resolveTimeZone(organizerTimeZone);
  const when = `${formatInTimeZone(scheduledAt, zone)} (${zoneLabel(scheduledAt, zone)})`;
  await sendEmail({
    to,
    // no-user-row: the reminder half of the guest invite, addressed to the same
    // account-less MeetingGuest — and it already stops on its own when the guest
    // declines, which is the only "opt out" that address can express.
    category: 'meeting-guest-reminder',
    subject: `Reminder: ${title} starts soon`,
    html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      ${name ? `<p>Hi ${esc(name)},</p>` : ''}
      <p>This is a reminder for <strong>${esc(title)}</strong>.</p>
      <p><strong>When:</strong> ${esc(when)} (in about ${minutes} minute${minutes === 1 ? '' : 's'})</p>
      ${meetLink ? `<p><strong>Meeting link:</strong> <a href="${meetLink}">${esc(meetLink)}</a></p>` : ''}
      <p style="color:#9ca3af;font-size:12px;line-height:1.5;margin-top:20px;">
        You were invited to this meeting as a guest — no account needed, just open the link above.
      </p>
    </div>`,
  });
}

// --- Recurring project meetings (#51) ---------------------------------------
//
// A project's weekly call belongs to the whole project, not to a mentorship: the
// people who should show up are its members (owner, mentors, mentee developers
// and testers alike), and most of them have no MentorshipRelation carrying the
// project. So these reminders are driven straight off the MeetingSeries rule
// instead of the per-relation `Meeting` rows, and their idempotency marker is a
// MeetingSeriesReminder row per (series, occurrence, lead time): the insert has
// to win before anything is sent, so an overlapping cron tick can't double-mail.
//
// Two lead times, because "the weekly meeting is tomorrow" and "it starts in an
// hour" are different reminders: DAY_BEFORE (~24h) and HOUR_BEFORE (~1h).
const SERIES_LOOKAHEAD_MINUTES = 25 * 60;

// Occurrences strictly after `from` and within the lookahead. The expansion
// itself lives in lib/meetingSeriesOccurrences so the reminder can never
// disagree with the calendar about what time the meeting is (#1110).
function upcomingSeriesOccurrences(
  series: { daysOfWeek: unknown; timeOfDay: string; timeZone: string | null },
  from: Date,
  withinMinutes: number
): Date[] {
  const horizon = new Date(from.getTime() + withinMinutes * 60 * 1000);
  return seriesOccurrences(series.daysOfWeek, series.timeOfDay, from, horizon, series.timeZone).filter(
    (when) => when > from
  );
}

function leadFor(minutesAway: number): 'DAY_BEFORE' | 'HOUR_BEFORE' | null {
  if (minutesAway <= 60) return 'HOUR_BEFORE';
  if (minutesAway >= 23 * 60) return 'DAY_BEFORE';
  return null;
}

export async function sendProjectMeetingSeriesReminders() {
  const now = new Date();
  const seriesList = await prisma.meetingSeries.findMany({
    where: { active: true, projectId: { not: null } },
    select: {
      id: true,
      title: true,
      daysOfWeek: true,
      timeOfDay: true,
      timeZone: true,
      fixedLink: true,
      projectId: true,
      project: { select: { id: true, name: true, orgId: true } },
    },
  });

  let reminded = 0;
  let notified = 0;
  let emailed = 0;

  for (const series of seriesList) {
    if (!series.projectId) continue;

    const occurrences = upcomingSeriesOccurrences(series, now, SERIES_LOOKAHEAD_MINUTES);
    if (occurrences.length === 0) continue;

    // The whole team, not just the ProjectMember rows: a mentee attached to the
    // project the legacy way (MentorshipRelation.projectId) is expected at the
    // same call, and since series meetings are now excluded from the
    // per-relation reminder they would otherwise be reminded by nobody.
    const team = await loadProjectTeam(series.projectId);
    if (team.length === 0) continue;
    const recipients = await prisma.user.findMany({
      where: { id: { in: team.map((m) => m.id) }, isActive: true },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        emailNotifications: true,
        notificationPrefs: true,
        timezone: true,
      },
    });
    if (recipients.length === 0) continue;

    for (const when of occurrences) {
      const lead = leadFor((when.getTime() - now.getTime()) / 60000);
      if (!lead) continue;

      // Claim first — see the idempotency note above.
      try {
        await prisma.meetingSeriesReminder.create({ data: { seriesId: series.id, occurrenceAt: when, lead } });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
        throw e;
      }
      reminded++;

      const projectName = series.project?.name ?? '';
      for (const user of recipients) {
        const link = `/projects/${series.projectId}`;
        const whenLocal = formatInTimeZone(when, user.timezone);
        await notify(
          user.id,
          lead === 'HOUR_BEFORE' ? 'meeting_reminder.seriesSoon' : 'meeting_reminder.seriesTomorrow',
          { title: series.title, project: projectName, when: whenLocal },
          link
        );
        notified++;

        if (!user.email || !emailAllowed(user, 'meetingReminders') || !emailGroupAllowedForCategory(user, 'meeting-series-reminder')) continue;
        try {
          const brand = await emailBrand(series.project?.orgId ?? null);
          await sendEmail({
            // Split out of 'meeting-reminder' so the recurring project blast is
            // distinguishable in the delivery log; same group either way.
            category: 'meeting-series-reminder',
            userId: user.id,
            to: user.email,
            fromName: brand.name,
            subject:
              lead === 'HOUR_BEFORE'
                ? `Reminder: ${series.title} starts soon`
                : `Tomorrow: ${series.title} (${projectName})`,
            html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              ${brandHeader(brand, 'Recurring project meeting')}
              <p>Hi ${esc(user.fullName ?? '')}, this is a reminder for <strong>${esc(series.title)}</strong>${projectName ? ` (${esc(projectName)})` : ''}.</p>
              <p><strong>When:</strong> ${whenLocal}</p>
              ${participantClocks(
                when,
                user.timezone,
                recipients.filter((r) => r.id !== user.id).map((r) => ({ name: r.fullName, timezone: r.timezone }))
              )}
              ${series.fixedLink ? `<p><strong>Meeting link:</strong> <a href="${series.fixedLink}">${esc(series.fixedLink)}</a></p>` : ''}
              ${ctaBlock(brand, `${appUrl()}${link}`, 'Open the project')}
              ${timeZoneNote(user.timezone)}
            </div>`,
          });
          emailed++;
        } catch (e) {
          // One bad address must not cost the rest of the team their reminder.
          console.error('Project meeting reminder email failed:', e);
        }
      }
    }
  }

  return { series: seriesList.length, reminded, notified, emailed };
}

// Weekly per-mentor digest: stale mentees, upcoming meetings, new applications.
export async function sendWeeklyMentorDigests() {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const in7d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const mentors = await prisma.user.findMany({
    where: { role: 'MENTOR', isActive: true },
    select: {
      id: true,
      email: true,
      fullName: true,
      emailNotifications: true,
      notificationPrefs: true,
      mentorRelations: {
        select: {
          startDate: true,
          interactions: { orderBy: { date: 'desc' }, take: 1, select: { date: true } },
          meetings: { where: { scheduledAt: { gt: now, lte: in7d } }, select: { id: true } },
        },
      },
    },
  });

  let sent = 0;
  for (const m of mentors) {
    if (m.mentorRelations.length === 0) continue;
    if (!emailAllowed(m, 'digest') || !emailGroupAllowedForCategory(m, 'mentor-digest')) continue;
    const stale = m.mentorRelations.filter(
      (r) => !r.interactions[0] || r.interactions[0].date < fourteenDaysAgo
    ).length;
    const upcoming = m.mentorRelations.reduce((n, r) => n + r.meetings.length, 0);
    const newApplications = m.mentorRelations.filter((r) => r.startDate >= weekAgo).length;

    try {
      await sendEmail({
        category: 'mentor-digest',
        userId: m.id,
        to: m.email,
        subject: 'Your weekly mentoring summary',
        html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color:#2563eb;">Weekly summary</h2>
          <p>Hi ${m.fullName}, here's your week at a glance:</p>
          <ul>
            <li><strong>${stale}</strong> mentee(s) with no interaction in 14+ days</li>
            <li><strong>${upcoming}</strong> meeting(s) coming up this week</li>
            <li><strong>${newApplications}</strong> new application(s) in the last 7 days</li>
          </ul>
          <a href="${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/mentor" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;">Open dashboard</a>
        </div>`,
      });
      sent++;
    } catch (e) {
      console.error('Mentor digest failed:', e);
    }
  }
  return { mentors: mentors.length, sent };
}

// Renders the per-mentee rows of the daily activity digest email. Page-view /
// time-on-site columns are only meaningful for mentees who opted into activity
// tracking; they simply read 0 for those who didn't.
function activityDigestTable(items: MenteeActivity[]): string {
  const rows = items
    .map((m) => {
      const login =
        m.daysSinceLogin === null
          ? 'never'
          : m.daysSinceLogin <= 0
            ? 'today'
            : `${m.daysSinceLogin}d ago`;
      const flag = m.daysSinceLogin !== null && m.daysSinceLogin >= 7 ? ' ⚠️' : '';
      return `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${m.menteeName}${flag}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${login}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${formatDuration(m.timeOnSiteSec)} · ${m.pageViews}p</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${m.goalsCompleted}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${m.interactions}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${m.meetings}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${m.pipelineChanges}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${m.messagesSent}/${m.messagesReceived}</td>
      </tr>`;
    })
    .join('');
  return `<table style="border-collapse:collapse;width:100%;font-size:13px;">
    <thead><tr style="text-align:left;color:#6b7280;">
      <th style="padding:6px 8px;">Mentee</th><th style="padding:6px 8px;">Login</th>
      <th style="padding:6px 8px;">On site</th><th style="padding:6px 8px;">Goals</th>
      <th style="padding:6px 8px;">Interac.</th><th style="padding:6px 8px;">Meet.</th>
      <th style="padding:6px 8px;">Stage</th><th style="padding:6px 8px;">Msg s/r</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// Daily mentee-activity digest. Each mentor gets a summary of THEIR mentees'
// activity in the last 24h; each admin gets a system-wide summary. Respects the
// 'digest' email preference. Recipients with no mentees / no data are skipped.
export async function sendDailyActivityDigests() {
  const now = new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  let sent = 0;

  const mentors = await prisma.user.findMany({
    where: { role: 'MENTOR', isActive: true },
    select: { id: true, email: true, fullName: true, emailNotifications: true, notificationPrefs: true },
  });
  for (const m of mentors) {
    if (!emailAllowed(m, 'digest') || !emailGroupAllowedForCategory(m, 'activity-digest')) continue;
    const items = await getMentorMenteeActivity(m.id, since);
    if (items.length === 0) continue;
    try {
      await sendEmail({
        category: 'activity-digest',
        userId: m.id,
        to: m.email,
        subject: 'Daily mentee activity',
        html: `<div style="font-family: Arial, sans-serif; max-width: 680px; margin: 0 auto;">
          <h2 style="color:#2563eb;">Daily mentee activity</h2>
          <p>Hi ${m.fullName}, here's what your mentees did in the last 24 hours:</p>
          ${activityDigestTable(items)}
          <p style="margin-top:16px;"><a href="${appUrl}/mentor/mentee-activity" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;">Open full report</a></p>
          <p style="color:#9ca3af;font-size:12px;">Time-on-site and page views are shown only for mentees who enabled activity tracking.</p>
        </div>`,
      });
      sent++;
    } catch (e) {
      console.error('Mentor activity digest failed:', e);
    }
  }

  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN', isActive: true },
    select: { id: true, email: true, fullName: true, emailNotifications: true, notificationPrefs: true },
  });
  const adminItems = await getSystemMenteeActivity(since);
  if (adminItems.length > 0) {
    for (const a of admins) {
      if (!emailAllowed(a, 'digest') || !emailGroupAllowedForCategory(a, 'activity-digest')) continue;
      try {
        await sendEmail({
          category: 'activity-digest',
          userId: a.id,
          to: a.email,
          subject: 'Daily mentee activity (all mentees)',
          html: `<div style="font-family: Arial, sans-serif; max-width: 680px; margin: 0 auto;">
            <h2 style="color:#2563eb;">Daily mentee activity</h2>
            <p>Hi ${a.fullName}, system-wide mentee activity in the last 24 hours:</p>
            ${activityDigestTable(adminItems)}
            <p style="margin-top:16px;"><a href="${appUrl}/admin/mentee-activity" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;">Open full report</a></p>
          </div>`,
        });
        sent++;
      } catch (e) {
        console.error('Admin activity digest failed:', e);
      }
    }
  }

  return { mentors: mentors.length, admins: admins.length, sent };
}

// Retention re-consent (GDPR Art. 5(1)(e) + 7): when a candidate's consent is
// older than the retention limit, email them a renewal link, notify them and
// admins in-app, and stamp the send so it isn't repeated. If they don't renew
// within the grace period they surface in the admin retention review for manual
// erasure — nothing is deleted automatically.
export async function checkRetentionReminders() {
  const months = await getRetentionMonths();
  const dueCutoff = new Date();
  dueCutoff.setMonth(dueCutoff.getMonth() - months);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  const users = await prisma.user.findMany({
    where: {
      role: 'MENTEE',
      consentAt: { not: null, lt: dueCutoff },
      retentionReminderSentAt: null,
    },
    select: { id: true, fullName: true, email: true },
  });

  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN', isActive: true },
    select: { id: true },
  });

  let reminded = 0;
  for (const u of users) {
    const renewUrl = `${appUrl}/consent/renew?token=${makeConsentRenewToken(u.id)}`;
    // Legal/retention notice — always sent (not gated by marketing opt-out).
    try {
      await sendEmail({
        category: 'retention-reminder',
        to: u.email,
        subject: 'Please confirm you still want us to keep your data',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color:#2563eb;">Do you want to keep your data with us?</h2>
            <p>Hi ${u.fullName},</p>
            <p>It has been more than ${months} months since you agreed to us storing your
            data (profile, CV and interaction history). To keep it, please confirm below.
            If you don't, an administrator will review your record for deletion.</p>
            <a href="${renewUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;margin:16px 0;">Keep my data</a>
            <p style="color:#6b7280;font-size:12px;">You can also download or delete your data anytime from Account settings.</p>
          </div>`,
      });
    } catch (e) {
      console.error('checkRetentionReminders email failed:', { userId: u.id, error: e });
    }
    await notify(u.id, 'retention.confirm', {}, `/consent/renew?token=${makeConsentRenewToken(u.id)}`);
    await prisma.user.update({ where: { id: u.id }, data: { retentionReminderSentAt: new Date() } });
    reminded += 1;
  }

  // Let admins know how many candidates are up for retention review.
  if (reminded > 0) {
    await Promise.all(
      admins.map((a) => notify(a.id, 'retention.adminSummary', { count: reminded }, '/admin/retention'))
    );
  }

  return { checked: users.length, reminded, retentionMonths: months, graceDays: RETENTION_GRACE_DAYS };
}

/**
 * "You said to write again — here we are" (#834).
 *
 * Idempotent by `reEngageNotifiedAt`: a tick that runs twice, or a container
 * that restarts mid-run, must not mail the same person twice. The stamp is
 * written per person immediately after their message, not in a batch at the
 * end, so a crash halfway through resumes rather than repeats.
 *
 * Consent is re-checked here (via dueForReminder) rather than trusted from the
 * date that was set months ago: someone can withdraw in between, and the whole
 * promise of the one-click link is that withdrawing actually stops the mail.
 */
export async function checkReEngagementReminders() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const people = await dueForReminder();

  let reminded = 0;
  for (const p of people) {
    const leaveUrl = `${appUrl}/re-engage?token=${makeLeaveToken(p.id)}`;
    try {
      await sendEmail({
        to: p.email,
        // The bespoke leave link in the body stays: it revokes the
        // RE_ENGAGEMENT_POOL *consent*, which is a stronger and different action
        // than "stop this group of mail". The group footer is additive.
        category: 're-engagement',
        userId: p.id,
        subject: 'Tekrar görüşelim mi? / Shall we talk again?',
        html: `<p>Merhaba ${p.fullName},</p>
<p>Daha önce seninle yeni bir dönem açıldığında tekrar iletişime geçmemizi kabul etmiştin. O zaman geldi.</p>
${p.reEngageNote ? `<p><em>${p.reEngageNote}</em></p>` : ''}
<p>İlgilenmiyorsan tek tıkla çıkabilirsin: <a href="${leaveUrl}">bana bir daha yazmayın</a>.</p>`,
      });
    } catch (e) {
      console.error('checkReEngagementReminders email failed:', { userId: p.id, error: e });
    }
    await notify(p.id, 're_engagement.due', {}, '/portal');
    await prisma.user.update({ where: { id: p.id }, data: { reEngageNotifiedAt: new Date() } });
    reminded += 1;
  }

  if (reminded > 0) {
    const admins = await prisma.user.findMany({ where: { role: 'ADMIN', isActive: true }, select: { id: true } });
    await Promise.all(admins.map((a) => notify(a.id, 're_engagement.adminSummary', { count: reminded }, '/admin/candidates?view=pool')));
  }
  return { checked: people.length, reminded };
}

// Does a consenting candidate match any of a company's open positions? A match
// is a loose, case-insensitive overlap between a need's position and the
// candidate's target position or one of their skills — deliberately generous
// (the alert is a "worth a look" nudge, not a hard filter).
function candidateMatchesNeeds(
  positions: string[],
  cand: { targetPosition?: string | null; skills: unknown }
): boolean {
  const target = (cand.targetPosition || '').toLowerCase().trim();
  const skills = (Array.isArray(cand.skills) ? cand.skills : []).map((s) => String(s).toLowerCase().trim()).filter(Boolean);
  return positions.some((pos) => {
    if (!pos) return false;
    if (target && (target.includes(pos) || pos.includes(target))) return true;
    return skills.some((sk) => sk && (pos.includes(sk) || sk.includes(pos)));
  });
}

// Only an OPEN requisition is hiring: DRAFT is unpublished, and ON_HOLD /
// FILLED / CANCELLED are all "do not send me candidates" (#1387).
const ALERTABLE_REQUISITION_STATUS = 'OPEN';

// Premium open-position match alerts (Faz 1, #530). For every company holding
// the COMPANY_NEED_MATCH_ALERTS entitlement, scan the consenting talent pool
// (the same publicProfile-only visibility as talent-pool search) for candidates
// matching an open position, and notify the company's users once per candidate.
// Repeat notifications are prevented by the CompanyNeedAlert dedupe row (the
// unique [companyId, menteeId] insert is the marker — createMany/skipDuplicates
// makes "insert-or-skip" atomic, so a candidate only ever alerts a company once).
//
// Positions come from BOTH tables (#1387). The job used to read CompanyNeed
// only, so a role opened through the Requisition screen — the newer of the two,
// and the one the product is migrating to — never matched anybody: a premium
// company could have five open requisitions and receive nothing at all.
// CompanyNeed is NOT dead and is not being dropped here: the admin company form
// still writes those rows (src/app/api/companies/[id]/route.ts), and the
// CompanyNeed→Requisition backfill is manual and runs in no deploy step. So this
// adds a source rather than replacing one; the [companyId, menteeId] dedupe key
// means a company with the same role in both tables still alerts once.
export async function checkCompanyNeedMatches() {
  const companies = await prisma.company.findMany({
    where: {
      entitlements: { some: { feature: 'COMPANY_NEED_MATCH_ALERTS' } },
      OR: [{ needs: { some: {} } }, { requisitions: { some: { status: ALERTABLE_REQUISITION_STATUS } } }],
    },
    select: {
      id: true,
      name: true,
      needs: { select: { position: true } },
      requisitions: {
        where: { status: ALERTABLE_REQUISITION_STATUS },
        // `openings`/`filled` so a role that is open-but-fully-staffed can be
        // dropped: the API accepts status OPEN with filled === openings, and
        // Prisma cannot compare two columns in a `where`, so it is filtered
        // below in JS.
        select: { title: true, openings: true, filled: true },
      },
      users: {
        where: { role: 'COMPANY', isActive: true },
        select: { id: true, email: true, fullName: true, emailNotifications: true, notificationPrefs: true },
      },
    },
  });
  if (companies.length === 0) return { companies: 0, alerts: 0 };

  // The consenting talent pool — publicProfile opt-in AND an active
  // TALENT_POOL_VISIBILITY consent (#527), same visibility rule as talent-pool
  // search.
  const pool = await prisma.user.findMany({
    where: {
      role: 'MENTEE',
      isActive: true,
      publicProfile: true,
      consents: { some: { type: 'TALENT_POOL_VISIBILITY', grantedAt: { not: null }, revokedAt: null } },
    },
    select: { id: true, fullName: true, targetPosition: true, skills: true },
  });
  if (pool.length === 0) return { companies: companies.length, alerts: 0 };

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  let alerts = 0;

  for (const company of companies) {
    // Requisition.title is the analogue of CompanyNeed.position, and the only
    // field taken from it. `requiredSkills` is deliberately NOT folded in:
    // candidateMatchesNeeds matches substrings in BOTH directions, so a short
    // skill like "Go" or "R" would match almost every targetPosition and turn a
    // premium alert into noise. Widening the match is a separate decision from
    // fixing the missing source.
    const positions = [
      ...company.needs.map((n) => n.position),
      ...company.requisitions.filter((r) => r.filled < r.openings).map((r) => r.title),
    ]
      .map((p) => (p ?? '').toLowerCase().trim())
      .filter(Boolean);
    // Still reachable after the OR filter above: a company can match on having
    // open requisitions and then have every one of them fully staffed.
    if (positions.length === 0) continue;
    const terms = [...new Set(positions)];

    for (const cand of pool) {
      if (!candidateMatchesNeeds(terms, cand)) continue;

      // Atomic dedupe: the insert succeeds only the first time; count 0 means
      // this company was already alerted about this candidate — skip silently.
      const created = await prisma.companyNeedAlert.createMany({
        data: [{ companyId: company.id, menteeId: cand.id }],
        skipDuplicates: true,
      });
      if (created.count === 0) continue;

      alerts += 1;
      const link = `/p/${cand.id}`;
      for (const u of company.users) {
        await notify(u.id, 'need_match.newCandidate', { candidateName: cand.fullName }, link);
        // 'company-need-alert' is `opportunities`, not `digests` — the stray
        // legacy 'digest' conjunct that used to stand here was reading another
        // group's key and dropping alerts the surfaces showed as ON. It now
        // lives in opportunities.legacy.
        if (emailGroupAllowedForCategory(u, 'company-need-alert')) {
          await sendEmail({
            category: 'company-need-alert',
            userId: u.id,
            to: u.email,
            subject: 'A candidate matches your open position',
            html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color:#2563eb;">New matching candidate</h2>
              <p>Hi ${u.fullName},</p>
              <p><strong>${cand.fullName}</strong> matches one of ${company.name}'s open positions${cand.targetPosition ? ` (${cand.targetPosition})` : ''}.</p>
              <p><a href="${appUrl}${link}">View profile</a></p>
            </div>`,
          }).catch((error) => {
            console.error('checkCompanyNeedMatches email failed:', { companyId: company.id, userId: u.id, error });
          });
        }
      }
    }
  }

  return { companies: companies.length, alerts };
}

// Weekly missing-document reminders (#811). Completion is derived live from
// requirements + uploaded documents; this job stores only per-week delivery
// claims so overlapping/manual cron runs cannot notify the same recipient twice.
export async function sendWeeklyMissingDocumentReminders(now = new Date()) {
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = weekStart.getUTCDay();
  weekStart.setUTCDate(weekStart.getUTCDate() - ((day + 6) % 7));

  const orgs = await prisma.organization.findMany({
    where: { documentRequirements: { some: { active: true, mandatory: true } } },
    select: { id: true },
  });
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  let claims = 0;
  let notified = 0;
  let emailed = 0;

  for (const org of orgs) {
    let page = 1;
    let eligibleUserCount = 0;
    do {
      const result = await bulkMissingRequirements({ orgId: org.id, role: 'MENTEE', page, pageSize: 100, locale: defaultLocale });
      eligibleUserCount = result.eligibleUserCount;
      const mentees = await prisma.user.findMany({
        where: { id: { in: result.rows.map((row) => row.user.id) }, isActive: true },
        select: {
          id: true, fullName: true, email: true, orgId: true, preferredLanguage: true, emailNotifications: true, notificationPrefs: true,
          menteeRelations: {
            where: { status: 'ACTIVE', mentor: { isActive: true } },
            select: { id: true, mentor: { select: { id: true, fullName: true, email: true, orgId: true, preferredLanguage: true, emailNotifications: true, notificationPrefs: true } } },
          },
        },
      });
      const byId = new Map(mentees.map((mentee) => [mentee.id, mentee]));

      for (const row of result.rows) {
        const mentee = byId.get(row.user.id);
        if (!mentee) continue;
        const recipients = [
          { ...mentee, relationId: null },
          ...mentee.menteeRelations.map((relation) => ({ ...relation.mentor, relationId: relation.id })),
        ]
          .filter((recipient, index, all) => all.findIndex((candidate) => candidate.id === recipient.id) === index);
        for (const requirement of row.missing) {
          for (const recipient of recipients) {
            const claim = await prisma.documentRequirementReminder.createMany({
              data: [{ requirementId: requirement.id, menteeId: mentee.id, recipientId: recipient.id, weekStart }],
              skipDuplicates: true,
            });
            if (claim.count === 0) continue;
            claims++;
            const locale: Locale = isLocale(recipient.preferredLanguage) ? recipient.preferredLanguage : defaultLocale;
            const t = getDictionary(locale).documentRequirements;
            const label = requirement.labels[locale] || requirement.labels.en || requirement.key;
            const isMentee = recipient.id === mentee.id;
            const link = isMentee ? '/portal/profile#documents' : `/mentor/mentees/${recipient.relationId}`;
            await notify(
              recipient.id,
              isMentee ? 'missing_document.self' : 'missing_document.mentor',
              isMentee ? { requirement: label } : { mentee: mentee.fullName, requirement: label },
              link
            );
            notified++;

            if (!recipient.email || !emailAllowed(recipient, 'documents') || !emailGroupAllowedForCategory(recipient, 'document-reminder')) continue;
            try {
              const brand = await emailBrand(recipient.orgId);
              await sendEmail({
                category: 'document-reminder',
                userId: recipient.id,
                locale: recipient.preferredLanguage,
                to: recipient.email,
                fromName: brand.name,
                subject: t.reminderSubject.replace('{requirement}', label),
                html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
                  ${brandHeader(brand, t.reminderHeading)}
                  <p>${esc(t.reminderGreeting.replace('{name}', recipient.fullName))}</p>
                  <p>${esc(t.reminderBody.replace('{requirement}', label).replace('{mentee}', mentee.fullName))}</p>
                  ${ctaBlock(brand, `${appUrl}${link}`, t.reminderCta)}
                </div>`,
              });
              emailed++;
            } catch (error) {
              console.error('Missing document reminder email failed:', { menteeId: mentee.id, recipientId: recipient.id, requirementId: requirement.id, error });
            }
          }
        }
      }
      page++;
    } while ((page - 1) * 100 < eligibleUserCount);
  }
  return { organizations: orgs.length, claims, notified, emailed, weekStart };
}

// Weekly scheduled analytics report email (Faz 2, #541). Premium: only runs
// when the premiumAnalytics setting is on. Sends every active admin a compact
// pipeline summary — total relations, hired conversion, stage counts and the
// last 7 days' activity — honoring the per-user digest email opt-out.
export async function sendWeeklyAnalyticsReport() {
  if ((await getSetting('premiumAnalytics')) !== 'true') return { locked: true, sent: 0 };

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [byStage, newRelations, interactions, admins] = await Promise.all([
    prisma.mentorshipRelation.groupBy({ by: ['pipelineStatus'], _count: { _all: true } }),
    prisma.mentorshipRelation.count({ where: { startDate: { gte: weekAgo } } }),
    prisma.interactionLog.count({ where: { date: { gte: weekAgo } } }),
    prisma.user.findMany({
      where: { role: 'ADMIN', isActive: true },
      select: { id: true, email: true, fullName: true, emailNotifications: true, notificationPrefs: true },
    }),
  ]);

  const total = byStage.reduce((n, s) => n + s._count._all, 0);
  const hired = byStage
    .filter((s) => s.pipelineStatus === 'HIRED_660' || s.pipelineStatus === 'EMPLOYED_700')
    .reduce((n, s) => n + s._count._all, 0);
  const conversion = total ? Math.round((hired / total) * 100) : 0;
  const stageRows = byStage
    .sort((a, b) => b._count._all - a._count._all)
    .map((s) => `<tr><td style="padding:4px 12px 4px 0;">${s.pipelineStatus}</td><td style="padding:4px 0;"><strong>${s._count._all}</strong></td></tr>`) // eslint-disable-line
    .join('');
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  let sent = 0;
  for (const a of admins) {
    // 'analytics-report' is `reports_analytics`; the legacy 'digest' conjunct
    // that used to stand here belonged to `digests` and killed the report while
    // the preference surfaces showed it as ON. 'digest' is in
    // reports_analytics.legacy now, so the old opt-out still holds visibly.
    if (!emailGroupAllowedForCategory(a, 'analytics-report')) continue;
    await sendEmail({
      category: 'analytics-report',
      userId: a.id,
      to: a.email,
      subject: 'Weekly analytics report — Internship CRM',
      html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color:#2563eb;">Weekly analytics report</h2>
        <p>Hi ${a.fullName},</p>
        <p><strong>${total}</strong> mentorship relations · <strong>${conversion}%</strong> hired conversion ·
        last 7 days: <strong>${newRelations}</strong> new relations, <strong>${interactions}</strong> interactions.</p>
        <table style="font-size:14px;border-collapse:collapse;">${stageRows}</table>
        <p><a href="${appUrl}/admin/analytics">Open the analytics dashboard</a></p>
      </div>`,
    }).catch((error) => {
      console.error('sendWeeklyAnalyticsReport email failed:', { userId: a.id, error });
    });
    sent++;
  }
  return { locked: false, sent };
}

// Unread-message digest (#667): once an hour, gather messages that have been
// unread for over UNREAD_DIGEST_AFTER_MIN minutes and not yet digested, group by
// recipient, and send ONE summary email (opt-in). Complements the instant in-app
// notification without spamming per message. Idempotent via Message.digestedAt,
// so a message is never included in more than one digest.
const UNREAD_DIGEST_AFTER_MIN = 60;

export async function sendUnreadMessageDigests() {
  const now = new Date();
  const cutoff = new Date(now.getTime() - UNREAD_DIGEST_AFTER_MIN * 60 * 1000);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  const userSelect = { id: true, fullName: true, email: true, emailNotifications: true, notificationPrefs: true } as const;
  const msgs = await prisma.message.findMany({
    // relationId is nullable since #768; the digest covers mentorship threads
    // only, so conversation-only messages are skipped (and left un-digested for
    // the conversation-layer digest to pick up later).
    where: { readAt: null, digestedAt: null, deletedForEveryoneAt: null, createdAt: { lt: cutoff }, relationId: { not: null } },
    orderBy: { createdAt: 'asc' },
    include: {
      relation: { include: { mentor: { select: userSelect }, mentee: { select: userSelect } } },
    },
  });

  // Group unread messages by recipient (the participant who is NOT the sender).
  type Recipient = NonNullable<(typeof msgs)[number]['relation']>['mentor'];
  const byRecipient = new Map<
    string,
    { recipient: Recipient; items: { relationId: string; from: string; preview: string }[] }
  >();
  const allIds: string[] = [];
  for (const m of msgs) {
    const rel = m.relation;
    // Defensive: the query filters relationId out, so this cannot normally fire.
    if (!rel) continue;
    allIds.push(m.id);
    const recipient = m.senderId === rel.mentorId ? rel.mentee : rel.mentor;
    const sender = m.senderId === rel.mentorId ? rel.mentor : rel.mentee;
    if (!recipient?.email) continue;
    const entry = byRecipient.get(recipient.id) ?? { recipient, items: [] };
    entry.items.push({
      relationId: rel.id,
      from: sender?.fullName ?? 'Someone',
      preview: m.body.slice(0, 120),
    });
    byRecipient.set(recipient.id, entry);
  }

  let sent = 0;
  for (const { recipient, items } of byRecipient.values()) {
    // The mail's taxonomy home is `digests`, and that is the only thing checked
    // here. The legacy 'messages' key existing opt-outs are recorded under maps
    // to direct_messages, so as a conjunct it suppressed a digest the surfaces
    // showed as ON; it is listed in digests.legacy instead.
    if (!emailGroupAllowedForCategory(recipient, 'unread-digest')) continue;
    const rows = items
      .map((it) => {
        const safe = it.preview.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));
        // Deliberately NO per-line reaction links here, unlike the live
        // notification. A five-item digest would carry 25 extra links, and a
        // high link count is one of the strongest spam signals there is —
        // exactly what this whole change set exists to avoid. The digest is a
        // "what did I miss" summary; reacting belongs on the message email.
        return `<li style="margin-bottom:8px;"><strong>${it.from}:</strong> ${safe || '(attachment)'} — <a href="${appUrl}/messages/${it.relationId}">Open</a></li>`;
      })
      .join('');
    // One link that clears the whole summary. Every item here belongs to the
    // same recipient, so marking each distinct thread read covers all of them.
    const relationIds = [...new Set(items.map((it) => it.relationId))];
    const markAllHtml = relationIds
      .map(
        (relationId, i) =>
          `<a href="${markReadUrl(relationId, recipient.id)}" style="color:#6b7280;">${
            relationIds.length === 1 ? 'Mark this conversation as read' : `Mark conversation ${i + 1} as read`
          }</a>`,
      )
      .join(' · ');
    try {
      await sendEmail({
        to: recipient.email!,
        userId: recipient.id,
        category: 'unread-digest',
        subject: `You have ${items.length} unread message${items.length === 1 ? '' : 's'}`,
        html: `<div style="font-family: Arial, sans-serif; max-width: 680px; margin: 0 auto;">
          <h2 style="color:#2563eb;">Unread messages</h2>
          <p>Hi ${recipient.fullName}, you have ${items.length} unread message${items.length === 1 ? '' : 's'} waiting:</p>
          <ul style="padding-left:18px;">${rows}</ul>
          <p style="font-size:13px;color:#6b7280;">${markAllHtml}</p>
          <p style="font-size:12px;color:#9ca3af;">Replying to a message also marks it — and everything before it — as read, so an answered conversation will not appear here again.</p>
        </div>`,
      });
      sent++;
    } catch (e) {
      console.error('Unread message digest failed:', e);
    }
  }

  // Mark every considered message as digested (even for opted-out recipients) so
  // the cron never reprocesses them.
  if (allIds.length) {
    await prisma.message.updateMany({ where: { id: { in: allIds } }, data: { digestedAt: now } });
  }
  return { sent, considered: allIds.length };
}

// How long a delivery-log row is kept (#1211). The log exists to answer "did
// our mail go out?", and that question is asked within hours of a problem —
// but every row holds a recipient address, so keeping them forever would build
// a second, unmanaged store of personal data next to the one the retention
// rules already govern.
export const EMAIL_LOG_RETENTION_DAYS = 90;

export async function pruneEmailLog(retentionDays: number = EMAIL_LOG_RETENTION_DAYS) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const { count } = await prisma.emailLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return { deleted: count, cutoff };
}

const scheduledTasks = new Map<string, ReturnType<typeof cron.schedule>>();

export function initCronJobs() {
  if (scheduledTasks.has('mentor-reminders')) return;

  // Run every day at 9:00 AM
  const task = cron.schedule('0 9 * * *', async () => {
    console.log('[Cron] Running mentor interaction reminder check...');
    try {
      // Before the reminders, not after: the sweep is what decides who counts as
      // a dormant first contact today, and the interaction reminder reads that
      // same rule to leave them alone.
      const dormant = await sweepDormantFirstContacts();
      console.log(`[Cron] Dormant first contacts: flagged ${dormant.flagged}, cleared ${dormant.cleared}`);
      const checkIns = await sendDormantCheckIns();
      console.log(`[Cron] Dormant check-ins sent: ${checkIns.sent}`);
      const result = await checkMentorInteractionReminders();
      console.log(`[Cron] Done. Checked: ${result.checked}, Reminded: ${result.reminded}`);
      const dl = await checkStageDeadlineReminders();
      console.log(`[Cron] Stage deadline reminders: ${dl.reminded}`);
      const rr = await checkRetentionReminders();
      console.log(`[Cron] Retention re-consent reminders: ${rr.reminded}`);
      const nm = await checkCompanyNeedMatches();
      console.log(`[Cron] Company need-match alerts: ${nm.alerts}`);
      // Housekeeping, not mail: keeps the delivery log inside its retention
      // window so recipient addresses do not accumulate indefinitely (#1211).
      const pruned = await pruneEmailLog();
      console.log(`[Cron] Email log pruned: ${pruned.deleted} row(s) older than ${EMAIL_LOG_RETENTION_DAYS} days`);
    } catch (error) {
      console.error('[Cron] Error running reminder check:', error);
    }
  });

  scheduledTasks.set('mentor-reminders', task);

  // Meeting reminders — every 15 minutes. The reminder window is 60 minutes
  // (MEETING_REMINDER_WINDOW_MINUTES); an hourly tick would fire anywhere from
  // 0 to 60 minutes ahead, so a quarter-hourly tick is what actually delivers
  // "about an hour before" (45-60 min). reminderSentAt keeps it single-shot.
  const meetingTask = cron.schedule('*/15 * * * *', async () => {
    try {
      const r = await sendMeetingReminders();
      if (r.reminded) {
        console.log(`[Cron] Meeting reminders. Reminded: ${r.reminded}, in-app: ${r.notified}, emails: ${r.emailed}`);
      }
      // Recurring project meetings ride the same tick: their windows are 1h/24h
      // wide, so a quarter-hourly check is what makes "an hour before" accurate.
      const s = await sendProjectMeetingSeriesReminders();
      if (s.reminded) {
        console.log(`[Cron] Project meeting reminders. Occurrences: ${s.reminded}, in-app: ${s.notified}, emails: ${s.emailed}`);
      }
      // Meetings that took place get their interaction log written for them
      // (#1489). Rides this tick because it watches the same rows: a meeting
      // ended by hand is logged on the click, this catches the ones nobody
      // ended, two hours after they started.
      const a = await sweepMeetingInteractionLogs();
      if (a.logged) {
        console.log(`[Cron] Meeting interaction logs written: ${a.logged}`);
      }
    } catch (e) {
      console.error('[Cron] Meeting reminder error:', e);
    }
  });
  scheduledTasks.set('meeting-reminders', meetingTask);

  // Weekly mentor digest — Mondays 8:00.
  const digestTask = cron.schedule('0 8 * * 1', async () => {
    try {
      const r = await sendWeeklyMentorDigests();
      console.log(`[Cron] Weekly digests sent: ${r.sent}`);
    } catch (e) {
      console.error('[Cron] Digest error:', e);
    }
  });
  scheduledTasks.set('weekly-digest', digestTask);

  // Weekly premium analytics report — Mondays 8:15 (no-op while the
  // premiumAnalytics setting is off).
  const analyticsTask = cron.schedule('15 8 * * 1', async () => {
    try {
      const r = await sendWeeklyAnalyticsReport();
      if (!r.locked) console.log(`[Cron] Weekly analytics reports sent: ${r.sent}`);
    } catch (e) {
      console.error('[Cron] Analytics report error:', e);
    }
  });
  scheduledTasks.set('analytics-report', analyticsTask);

  // Hourly e-mail delivery health check (#1190) — alerts when sends keep
  // failing or the last success goes stale while attempts continue.
  const emailHealthTask = cron.schedule('5 * * * *', async () => {
    try {
      await runEmailHealthCheck();
    } catch (e) {
      logger.error('Email health cron failed', { error: String(e) });
    }
  });
  scheduledTasks.set('email-health', emailHealthTask);

  // Missing mandatory documents — Mondays 08:30, offset from the other weekly jobs.
  const documentTask = cron.schedule('30 8 * * 1', async () => {
    try {
      const result = await sendWeeklyMissingDocumentReminders();
      console.log(`[Cron] Missing document reminders: ${result.notified}`);
    } catch (error) {
      console.error('[Cron] Missing document reminder error:', error);
    }
  });
  scheduledTasks.set('missing-document-reminders', documentTask);

  // Daily mentee-activity digest — every day at 7:30.
  const activityTask = cron.schedule('30 7 * * *', async () => {
    try {
      const r = await sendDailyActivityDigests();
      console.log(`[Cron] Daily activity digests sent: ${r.sent}`);
    } catch (e) {
      console.error('[Cron] Activity digest error:', e);
    }
  });
  scheduledTasks.set('activity-digest', activityTask);

  const weeklyReportTask = cron.schedule('0 15 * * 5', async () => {
    try {
      const result = await sendWeeklyReportReminders();
      console.log(`[Cron] Weekly report reminders: ${result.reminded}`);
    } catch (error) {
      console.error('[Cron] Weekly report reminder error:', error);
    }
  });
  scheduledTasks.set('weekly-report-reminders', weeklyReportTask);

  // Unread-message digest — hourly at :20 (offset from the other hourly jobs).
  const unreadDigestTask = cron.schedule('20 * * * *', async () => {
    try {
      const r = await sendUnreadMessageDigests();
      if (r.sent) console.log(`[Cron] Unread message digests sent: ${r.sent}`);
    } catch (e) {
      console.error('[Cron] Unread message digest error:', e);
    }
  });
  scheduledTasks.set('unread-message-digest', unreadDigestTask);

  // Housekeeping for "keep me signed in" (#1495) — nightly at 03:40. Expired
  // device rows and the spent one-minute refresh grants have no further use;
  // revoked devices are kept a month longer so a replayed cookie is still
  // recognisable (see purgeExpiredTrustedDevices).
  const trustedDeviceTask = cron.schedule('40 3 * * *', async () => {
    try {
      const r = await purgeExpiredTrustedDevices();
      if (r.devices || r.grants) {
        console.log(`[Cron] Trusted device purge: ${r.devices} devices, ${r.grants} grants`);
      }
    } catch (e) {
      console.error('[Cron] Trusted device purge error:', e);
    }
  });
  scheduledTasks.set('trusted-device-purge', trustedDeviceTask);

  console.log('[Cron] Scheduled jobs initialized');
}
