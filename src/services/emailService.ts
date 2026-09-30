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
import { notificationLink, type NotificationRole } from '@/lib/notificationLink';
import { capabilitiesMemo } from '@/lib/shellCapabilities';
import { interactionReminderApplies } from '@/lib/salesSurface';
import { markReadUrl } from '@/lib/emailActionToken';
import { getSetting } from '@/lib/settings';
import { emailAllowed, notificationCategoryAllowed } from '@/lib/notificationPrefs';
import { makeConsentRenewToken } from '@/lib/consentRenew';
import { dueForReminder, makeLeaveToken } from '@/lib/reEngagement';
import { getRetentionMonths, RETENTION_GRACE_DAYS } from '@/lib/retention';
// The batched-sweep helper only; `retentionPrune` holds no Prisma import and
// imports nothing of ours, so this stays a leaf dependency and cannot cycle.
import { pruneInBatches } from '@/lib/retentionPrune';
import { getMentorMenteeActivity, getSystemMenteeActivity, type MenteeActivity } from '@/lib/activityReport';
import { findDormantFirstContacts, sweepDormantFirstContacts } from '@/lib/dormantFirstContact';
import { getLastContacts } from '@/lib/lastContact';
import { overdueBefore } from '@/lib/taskDue';
import { visibleToViewer } from '@/lib/todoVisibility';
import { formatDate } from '@/lib/relativeTime';
import { getOrgBranding } from '@/lib/orgBranding';
import { mailAccentFor } from '@/lib/accent';
import { formatInTimeZone, readingsByZone, resolveTimeZone, sameWallClock, zoneLabel, type ZonedPerson } from '@/lib/timezone';
import { seriesOccurrences } from '@/lib/meetingSeriesOccurrences';
import { buildMeetingIcs } from '@/lib/ics';
import { loadProjectTeam } from '@/lib/projectTeam';
import { getDictionary } from '@/i18n/dictionaries';
import { applyVerticalOverlay } from '@/i18n/verticalOverlays';
import { verticalFor } from '@/lib/verticalContext';
import { isNextActionReminderDue, nextActionDueBefore } from '@/lib/nextActionRule';
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
// WORLDS (#2590): a link in a mail must open the product the RECIPIENT'S account
// lives in. The pure host/world rule and the org → world read are the two
// foundation modules; this file only ever asks them, it keeps no second copy.
import { originForWorld, type World } from '@/lib/hostWorld';
import { DEFAULT_VERTICAL, productNameFor, toVerticalKey } from '@/lib/verticals';
import { worldOfOrg } from '@/lib/userWorld';
import { appOriginForOrg, appOriginsForOrgs } from '@/lib/orgLinkOrigin';
import { defaultOrgId } from '@/lib/defaultOrg';
import { orgWhere } from '@/lib/tenantFilter';
import { outcomeStageKeys, resolvePipelineStages, stageLabel } from '@/lib/pipelineStages';
import { sameTenant } from '@/lib/orgScope';

// Resolved branding for a transactional email (#546). When no orgId is given
// (single-tenant, or a caller without tenant context) this returns the product
// defaults, so behavior is unchanged. An unset accent falls back to the org's
// WORLD colour (SaleVali magenta, else the product blue) — a marketing tenant
// that never picked a colour must not get internship-blue mail.
//
// Exported for the routes that assemble their own mail body (announcements, the
// deliverability probe): one brand rule, not a second lookup per route.
export async function emailBrand(orgId?: string | null) {
  const b = await getOrgBranding(orgId ?? null);
  return {
    name: b.name,
    accent: b.color || mailAccentFor(b.vertical),
    logoUrl: b.logoUrl,
    supportEmail: b.supportEmail,
    vertical: b.vertical,
    // The origin every link in this org's mail points at (#2495): its own
    // product host when one is mapped and served, else NEXT_PUBLIC_APP_URL.
    // Carried on the brand because the brand is already "who is this mail
    // from" — the same org decides the logo and the host its links open.
    appUrl: await appOriginForOrg(orgId),
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
export function brandHeader(brand: { name: string; accent: string; logoUrl: string | null }, heading: string): string {
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
// like bulk/spam than a bare address.
//
// The display name is the caller's brand when it gave one. A name already
// written into SMTP_FROM ("Name <addr>") is only the DEFAULT now: it used to be
// returned verbatim, which silently dropped every tenant's brand name — so on
// such a deployment a SaleVali recipient got the internship name on every mail.
function fromIdentity(brandName?: string | null, transport: MailTransport = 'primary'): { name: string; address: string } {
  // Bulk mail may carry its own sender identity (e.g. noreply@ersah.in) so that
  // digest complaints never touch the domain the password-reset mail is signed
  // with. Falls back to the primary address when unset, which keeps a
  // single-identity setup working unchanged.
  const configured =
    (transport === 'bulk' ? process.env.SMTP_BULK_FROM : undefined) ||
    process.env.SMTP_FROM ||
    (transport === 'bulk' ? process.env.SMTP_BULK_USER : undefined) ||
    process.env.SMTP_USER ||
    '';
  const angled = configured.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  const address = (angled ? angled[2] : configured).trim();
  const configuredName = angled?.[1].trim() || null;
  const name = brandName || configuredName || process.env.MAIL_FROM_NAME || 'Internship CRM';
  return { name, address };
}

function fromHeader(brandName?: string | null, transport: MailTransport = 'primary'): string {
  const { name, address } = fromIdentity(brandName, transport);
  return address ? `${name} <${address}>` : '';
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
//
// `origin` (#2590): the host these two links open on — the product the RECIPIENT'S
// account lives in, resolved by sendEmail. Optional and trailing so the unit
// specs (and any caller that only holds a user id) keep the internship origin
// they always got.
function unsubscribeFooterHtml(userId: string, group: EmailGroupId, locale?: string | null, origin?: string): string {
  const dict = getDictionary(resolveLocale(locale));
  const U = dict.unsubscribe;
  const name = dict.emailGroups[group].name;
  const unsub = unsubscribeUrl(userId, group, origin);
  const prefs = emailPreferencesUrl(userId, origin);
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
//
// The namespace is the RECIPIENT'S product host — the same origin their
// List-Unsubscribe URL uses. Mail clients show it as the list's name ("via
// digests.<host>"), so a fixed internship host named the other product in every
// SaleVali digest. The id still reads the same for everyone a group reaches
// within one world, which is all the grouping ever needed: one mailbox never
// receives one list from both worlds under one account.
function listIdHost(origin?: string): string {
  try {
    return new URL(origin ?? appUrl()).host;
  } catch {
    return 'localhost';
  }
}

function unsubscribeHeaders(userId: string, group: EmailGroupId, origin?: string): Record<string, string> {
  // `origin` (#2590) — see unsubscribeFooterHtml: the recipient's own product.
  const one = oneClickUnsubscribeUrl(userId, group, origin);
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
    h['List-Id'] = `<${group}.${listIdHost(origin)}>`;
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
  fromIdentity,
  recipientSenderName,
  htmlToText,
  // #1720 — the localisable fragments shared by the system mails. Exported for
  // the same reason as the footer builders above: SMTP never runs in a test
  // env, so the only way to assert "does this render in Turkish" is against the
  // string builders themselves. See e2e/system-mail-i18n.unit.spec.ts.
  resolveLocale,
  timeZoneNote,
  inMinutesText,
  organizerTimeLine,
  participantClocks,
  activityDigestTable,
  // Worlds (docs/worlds.md) — e2e/world-cron-builders.spec.ts.
  worldHeading,
  worldAccent,
  notifyOrgAdmins,
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

/**
 * The From display name for a mail whose caller named none (docs/worlds.md):
 * whatever a mail produces stays in its recipient's world, and a builder that
 * forgot `fromName` must not introduce a SaleVali reader as "Internship CRM".
 *
 * `null` — the default world: keep the configured name, byte-for-byte what it
 * always was (an internship tenant's brand is applied by the builders that pass
 * `fromName`, as before). A string — the recipient org's brand name. `false` —
 * the lookup failed, so the world is unknown; the caller sends a bare address.
 * With neither org nor user there is no recipient identity (an operator alert,
 * a guest nobody resolved): the default, and the caller's job to say otherwise.
 */
async function recipientSenderName(
  orgId: string | null | undefined,
  userId: string | null | undefined,
  known?: { orgId: string | null; vertical: string | null | undefined },
): Promise<string | null | false> {
  try {
    let org = orgId;
    if (org === undefined) {
      const row = known ?? (userId
        ? await prisma.user
            .findUnique({ where: { id: userId }, select: { orgId: true, org: { select: { vertical: true } } } })
            .then((u) => (u ? { orgId: u.orgId, vertical: u.org?.vertical } : undefined))
        : undefined);
      // The default world needs no brand read — the hot path of every digest.
      if (!row || toVerticalKey(row.vertical) === DEFAULT_VERTICAL) return null;
      org = row.orgId;
    }
    if (!org) return null;
    const brand = await getOrgBranding(org);
    return brand.vertical === DEFAULT_VERTICAL ? null : brand.name;
  } catch (e) {
    logger.warning('Sender name unresolved; sending from a bare address', { error: String(e) });
    return false;
  }
}

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
  orgId,
}: {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
  // `cid` makes an attachment *inline*: the HTML can then reference it as
  // <img src="cid:…">, which is how images inside a message body reach mail
  // clients (a URL into this app would need a session and render as broken).
  attachments?: { filename: string; content: Buffer; contentType?: string; cid?: string }[];
  // Overrides the From display name (e.g. a tenant's brand name, #546). When
  // omitted, a recipient outside the default world is named after their own
  // org's brand (see recipientSenderName); everyone else keeps MAIL_FROM_NAME /
  // "Internship CRM".
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
  // The recipient's ORGANIZATION (`User.orgId`), when the caller already holds it
  // (#2590). It decides which product the mail belongs to: the host the footer's
  // unsubscribe / preference links, the List-Unsubscribe URL and the List-Id
  // point at, and — when the caller named no sender — the From display name. An
  // INTERNSHIP account keeps what it always had; a MARKETING account gets the
  // marketing host and its own brand.
  //
  // Three states, and the difference matters: a string or an explicit `null`
  // (the default org ⇒ INTERNSHIP) is an answer and costs nothing; `undefined`
  // means "not told", and for a gated send this function then asks the database
  // — folded into the preference read it makes anyway when it can, so the common
  // path pays no extra round trip. A broadcast that hands over `prefs` (and so
  // skips that read) should hand over `orgId` too; without it each recipient
  // costs one small extra read.
  orgId?: string | null;
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
  // The recipient's world, when the preference read below happened to learn it.
  let storedWorld: World | undefined;
  // …and the org behind it, so the sender name needs no second user read.
  let storedOrg: { orgId: string | null; vertical: string | null | undefined } | undefined;

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
    //
    // The read also brings back the recipient's organization vertical (#2590),
    // so the footer below can point at the recipient's own product without a
    // second query. A nested select on the same primary-key lookup, not a join
    // anybody would notice.
    const stored = prefs
      ? null
      : await prisma.user
          .findUnique({
            where: { id: userId! },
            select: {
              emailNotifications: true,
              notificationPrefs: true,
              orgId: true,
              org: { select: { vertical: true } },
            },
          })
          .catch(() => null);
    const u = prefs ?? stored;
    if (orgId === undefined && stored) {
      storedWorld = toVerticalKey(stored.org?.vertical);
      storedOrg = { orgId: stored.orgId, vertical: stored.org?.vertical };
    }
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
    // WORLDS (#2590): the opt-out links open the recipient's OWN product. The
    // pages behind them are token-only and host-agnostic (the token names the
    // user row, the host can neither widen nor redirect it), so this is about
    // arriving in the right product — its brand, its language, its next click —
    // not about access.
    //
    // A lookup that fails fails the send. It used to fall back to the default
    // origin, which put a SaleVali reader's unsubscribe link (and List-Id) on the
    // internship host; dropping the footer instead would ship bulk mail with no
    // opt-out. This mail is non-essential by definition (`gated`), so not
    // sending it during a database error is the cheap side of that trade — and
    // callers already handle a throw here, it is what an SMTP failure does.
    let origin: string;
    try {
      origin =
        orgId !== undefined
          ? await appUrlFor(orgId)
          : storedWorld !== undefined
            ? appUrlForWorld(storedWorld)
            : await appUrlForUser(userId);
    } catch (e) {
      const message = `Recipient origin unresolved: ${e instanceof Error ? e.message : String(e)}`;
      logger.error('Email not sent: recipient origin unresolved', { to, category, error: message });
      await recordEmail(to, subject, category, 'FAILED', transport, message);
      throw e;
    }
    body = withUnsubscribeFooter(html, unsubscribeFooterHtml(userId!, groupId!, locale, origin));
    computed = unsubscribeHeaders(userId!, groupId!, origin);
  }
  // Caller last: an explicit header beats one we derived. Note the group check
  // above still ran either way — owning the *presentation* of an opt-out is not
  // permission to ignore the recipient's stored choice.
  const mergedHeaders = { ...(computed ?? {}), ...(headers ?? {}) };

  // After the SMTP short-circuits on purpose: a mail that is not going out
  // costs no brand lookup.
  const senderName = fromName || (await recipientSenderName(orgId, userId, storedOrg));
  const sender = fromIdentity(senderName || null, transport);

  try {
    await via.sendMail({
      // `false`: the recipient's world could not be read — a bare address names
      // no product, where the default name might name the wrong one. An object,
      // not a formatted string, so a tenant brand with a comma or a quote in it
      // is encoded by nodemailer instead of splitting the header.
      from: !sender.address ? '' : senderName === false ? sender.address : { name: sender.name, address: sender.address },
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

// LOCALE (#1720): `locale` is REQUIRED thinking, not an optional nicety — the
// invitee is the one recipient in this whole file who provably has no stored
// preference, because they have no account at all. Reading Accept-Language is
// not an option either: half these sends come from a bulk paste or a resend
// long after the admin's browser is gone.
//
// So the language is a decision the inviting admin makes, captured on the
// InvitationToken at creation time (`InvitationToken.locale`, chosen in the
// invite form and defaulting to the inviter's own UI language) and replayed
// from that column on every resend, so the second mail matches the first. The
// caller passes that column through; when it is null — a pre-#1720 row, a
// seeder/system invite — resolveLocale() falls back to the deployment default.
export async function sendInvitationEmail({
  to,
  token,
  role,
  orgId,
  locale,
}: {
  to: string;
  token: string;
  role: string;
  orgId?: string | null;
  /** The inviter's choice, stored on InvitationToken.locale. */
  locale?: string | null;
}) {
  // WORLDS (#2590): the invitation opens the product of the organization that is
  // inviting — the invited person may already hold an account in the OTHER
  // product under this very address, and accepting here creates the second,
  // independent one. INTERNSHIP (or no org): the origin it always had.
  const registerUrl = `${await appUrlFor(orgId)}/auth/register?token=${token}`;
  const brand = await emailBrand(orgId);
  const resolved = resolveLocale(locale);
  // In the inviting tenant's own vocabulary (#2558): a SaleVali invitation
  // asks a sales rep to join, not "a mentor". INTERNSHIP's overlay is empty.
  const vertical = orgId ? await verticalFor(orgId) : DEFAULT_VERTICAL;
  const I = applyVerticalOverlay(getDictionary(resolved), resolved, vertical).notifications.invitationEmail;
  // An unknown role string (nothing else can reach this today) prints as-is
  // rather than as an empty gap in the sentence.
  const roleLabel = I.roles[role as keyof typeof I.roles] ?? role;
  // Split rather than replace, so the role can be bolded without HTML entering
  // the dictionary — and so a locale that opens the sentence with {role}
  // (Turkish does) still renders correctly.
  const [bodyBefore, bodyAfter = ''] = I.body.split('{role}');

  return await sendEmail({
    to,
    fromName: brand.name,
    category: 'invitation',
    // An essential group, so there is no footer to translate here — but the
    // locale is passed anyway, so this send behaves like every other one if the
    // taxonomy ever moves it.
    locale: resolved,
    subject: I.subject.replace('{brand}', brand.name),
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, esc(I.heading.replace('{brand}', brand.name)))}
        <p>${esc(bodyBefore)}<strong>${esc(roleLabel)}</strong>${esc(bodyAfter)}</p>
        <p>${esc(I.ctaIntro)}</p>
        <a href="${registerUrl}" style="
          display: inline-block;
          background-color: ${brand.accent};
          color: white;
          padding: 12px 24px;
          text-decoration: none;
          border-radius: 6px;
          margin: 16px 0;
        ">
          ${esc(I.cta)}
        </a>
        <p style="color: #6b7280; font-size: 14px;">
          ${esc(I.expiry)}
        </p>
        <p style="color: #6b7280; font-size: 12px;">
          ${esc(I.copyLink)} ${registerUrl}
        </p>
      </div>
    `,
  });
}

// LOCALE (#1720): a password reset is always for an EXISTING account, so the
// language is that account's `User.preferredLanguage` — every caller reads the
// row it is minting the token for and passes that column. Deliberately not the
// browser's Accept-Language: /api/auth/forgot answers identically for an
// unknown address (no enumeration), so the request that triggers this one is
// often not the account owner's request at all.
//
// The SET_INITIAL half is the exception worth naming: the account was created
// seconds ago by an admin/mentor and has no preference yet. Those callers pass
// the CREATOR's language, on the same reasoning as the invitation — the person
// setting the account up knows what the recipient reads.
export async function sendPasswordResetEmail({
  to,
  token,
  fullName,
  purpose = 'RESET',
  orgId,
  locale,
}: {
  to: string;
  token: string;
  fullName?: string | null;
  purpose?: 'RESET' | 'SET_INITIAL';
  orgId?: string | null;
  /** The account's User.preferredLanguage (or, for SET_INITIAL, its creator's). */
  locale?: string | null;
}) {
  // WORLDS (#2590): the reset page must open in the product the ACCOUNT lives in
  // (`orgId` is that account's org; every caller passes the row's own). A reset
  // link into the other product would ask the right person to reset a password
  // on a site where that account does not exist. No org ⇒ the default product.
  const resetUrl = `${await appUrlFor(orgId)}/auth/reset?token=${token}`;
  const isInitial = purpose === 'SET_INITIAL';
  const brand = await emailBrand(orgId);
  const resolved = resolveLocale(locale);
  const P = getDictionary(resolved).notifications.passwordResetEmail;
  const V = isInitial ? P.setInitial : P.reset;

  return await sendEmail({
    to,
    fromName: brand.name,
    category: 'password-reset',
    locale: resolved,
    subject: V.subject.replace('{brand}', brand.name),
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, esc(V.heading))}
        ${fullName ? `<p>${esc(P.greeting.replace('{name}', fullName))}</p>` : ''}
        <p>${esc(V.body.replace('{brand}', brand.name))}</p>
        <a href="${resetUrl}" style="
          display: inline-block;
          background-color: ${brand.accent};
          color: white;
          padding: 12px 24px;
          text-decoration: none;
          border-radius: 6px;
          margin: 16px 0;
        ">
          ${esc(V.cta)}
        </a>
        <p style="color: #6b7280; font-size: 14px;">
          ${esc(V.expiry)}
        </p>
        <p style="color: #6b7280; font-size: 12px;">
          ${esc(P.copyLink)} ${resetUrl}
        </p>
      </div>
    `,
  });
}

// LOCALE (#1720): address verification always follows an existing account, so
// the language is that account's `User.preferredLanguage` — passed in by every
// caller, never read from the browser (the public resend path answers the same
// way for an address that does not exist, so the requester may not be the
// account owner). At sign-up the row is seconds old and the column is usually
// still null; registration through an invitation seeds it from
// `InvitationToken.locale`, and anything still unset falls back to the
// deployment default in resolveLocale().
export async function sendVerificationEmail({
  to,
  token,
  fullName,
  orgId,
  locale,
}: {
  to: string;
  token: string;
  fullName?: string | null;
  orgId?: string | null;
  /** The account's User.preferredLanguage. */
  locale?: string | null;
}) {
  // WORLDS (#2590): same rule as the reset link — the account's own product.
  const verifyUrl = `${await appUrlFor(orgId)}/auth/verify?token=${token}`;
  const brand = await emailBrand(orgId);
  const resolved = resolveLocale(locale);
  const V = getDictionary(resolved).notifications.verificationEmail;

  await sendEmail({
    to,
    fromName: brand.name,
    category: 'verification',
    locale: resolved,
    subject: V.subject.replace('{brand}', brand.name),
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, esc(V.heading))}
        ${fullName ? `<p>${esc(V.greeting.replace('{name}', fullName))}</p>` : ''}
        <p>${esc(V.body)}</p>
        <a href="${verifyUrl}" style="
          display: inline-block;
          background-color: ${brand.accent};
          color: white;
          padding: 12px 24px;
          text-decoration: none;
          border-radius: 6px;
          margin: 16px 0;
        ">
          ${esc(V.cta)}
        </a>
        <p style="color: #6b7280; font-size: 14px;">
          ${esc(V.expiry)}
        </p>
        <p style="color: #6b7280; font-size: 12px;">
          ${esc(V.copyLink)} ${verifyUrl}
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
  locale,
  orgId,
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
  // LOCALE (#1720): the invitee is a User here (that is what `userId` means), so
  // this is their `User.preferredLanguage` — every caller selects the column
  // alongside `timezone`, which the mail already reads per recipient for exactly
  // the same reason. Unset → the deployment default, as before.
  locale?: string | null;
  // The invitee's organization (`User.orgId`), for the origin of the RSVP buttons
  // and the time-zone link (#2590). Trailing and optional so existing callers
  // keep compiling: when it is omitted the account behind `userId` is asked, and
  // with neither (an address-only caller) the mail gets the default product.
  orgId?: string | null;
}) {
  // WORLDS (#2590): an RSVP button must open the product the invitee's account
  // lives in. The token in the URL is the credential, but the page it opens is
  // that product's, and a marketing invitee sent to the internship host lands in
  // a product they have no account in. The same org names the sender and
  // paints the header (docs/worlds.md) — none of the callers pass `orgId`.
  const recipientOrg =
    orgId !== undefined
      ? orgId
      : userId
        ? ((await prisma.user.findUnique({ where: { id: userId }, select: { orgId: true } }))?.orgId ?? null)
        : null;
  const brand = await emailBrand(recipientOrg);
  const base = recipientOrg ? brand.appUrl : appUrl();
  const yes = `${base}/rsvp/${rsvpToken}?r=yes`;
  const no = `${base}/rsvp/${rsvpToken}?r=no`;
  const resolved = resolveLocale(locale);
  const M = getDictionary(resolved).notifications.meetingInviteEmail;
  // A meeting with no set time is just a shared link — skip the "when" line and
  // the RSVP ask entirely.
  // The date is the payload of an invitation, so it follows the body's language
  // too — a Turkish invite that names the day in English is the half-translated
  // shape #1720 exists to end.
  const when = scheduledAt
    ? formatInTimeZone(scheduledAt, timeZone, { dateStyle: 'full', timeStyle: 'short' }, dateLocale(resolved))
    : null;
  const askRsvp = Boolean(when && rsvpToken);
  // A link-only meeting (no scheduledAt) has no slot to occupy, so it gets no
  // attachment at all — an .ics without a DTSTART is not a thing.
  const ics =
    scheduledAt && icsUid
      ? meetingIcsAttachment({
          product: await productNameForRecipient(orgId, userId),
          uid: icsUid,
          title,
          start: scheduledAt,
          meetLink,
          sequence,
          attendeeEmail: to,
          attendeeName: fullName,
          organizerName,
        })
      : null;

  await sendEmail({
    to,
    userId,
    orgId: recipientOrg,
    category: 'meeting-invite',
    locale: resolved,
    ...(ics ? { attachments: [ics] } : {}),
    subject: M.subject.replace('{title}', title),
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${worldHeading(brand, esc(title), `<h2 style="color: #2563eb;">${esc(title)}</h2>`)}
        ${fullName ? `<p>${esc(M.greeting.replace('{name}', fullName))}</p>` : ''}
        <p>${esc(M.body)}</p>
        ${when ? `<p><strong>${esc(M.when)}</strong> ${when}</p>` : ''}
        ${when && scheduledAt ? organizerTimeLine(scheduledAt, organizerTimeZone, timeZone, organizerName, resolved) : ''}
        ${meetLink ? `<p><strong>${esc(M.link)}</strong> <a href="${meetLink}">${meetLink}</a></p>` : ''}
        ${askRsvp ? `
        <p style="margin-top: 20px;">${esc(M.rsvpAsk)}</p>
        <a href="${yes}" style="display:inline-block;background:#16a34a;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;margin-right:8px;">${esc(M.rsvpYes)}</a>
        <a href="${no}" style="display:inline-block;background:#dc2626;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;">${esc(M.rsvpNo)}</a>
        ` : ''}
        ${when ? timeZoneNote(timeZone, resolved, base) : ''}
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
  locale,
  orgId,
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
  // LOCALE (#1720): the organizer's `User.preferredLanguage` — the same
  // reasoning as `organizerTimeZone` two fields up. A guest has no profile, so
  // there is no preference of their own to read; the only person who knows
  // anything about them is whoever typed their address into the scheduler.
  locale?: string | null;
  // The ORGANIZER's organization (#2590). A guest has no account and so no world
  // of their own; the person who invited them does, and the RSVP page they are
  // sent to is that person's product. Trailing and optional: omitted, the guest
  // gets the default (internship) origin, which is what every guest mail was.
  orgId?: string | null;
}) {
  // The organizer's brand, whole: sender name, header and accent. No org is
  // the internship defaults (DEFAULT_ACCENT is the blue this used to hardcode).
  const brand = await emailBrand(orgId);
  // appUrlFor's rule, without its second read of the same org row.
  const url = orgId ? brand.appUrl : appUrl();
  const yes = `${url}/rsvp/${rsvpToken}?r=yes`;
  const no = `${url}/rsvp/${rsvpToken}?r=no`;
  const resolved = resolveLocale(locale);
  const M = getDictionary(resolved).notifications.meetingInviteEmail;
  const T = getDictionary(resolved).notifications.emailTimes;
  const zone = resolveTimeZone(organizerTimeZone);
  const when = scheduledAt
    ? `${formatInTimeZone(scheduledAt, zone, { dateStyle: 'full', timeStyle: 'short' }, dateLocale(resolved))} (${zoneLabel(scheduledAt, zone)})`
    : null;
  const invitedBy = organizerName ? esc(organizerName) : null;
  const ics =
    scheduledAt && icsUid
      ? meetingIcsAttachment({
          product: productNameFor(await worldOfOrg(orgId)),
          uid: icsUid,
          title,
          start: scheduledAt,
          meetLink,
          sequence,
          attendeeEmail: to,
          attendeeName: name,
          organizerName,
        })
      : null;

  await sendEmail({
    to,
    fromName: brand.name,
    orgId: orgId ?? null,
    subject: M.subject.replace('{title}', title),
    ...(ics ? { attachments: [ics] } : {}),
    // no-user-row: a guest is an address somebody typed into the scheduler,
    // deliberately not an account here — there is no row to gate on and no
    // token to mint, and the mail says so in its own closing line instead.
    category: 'meeting-guest-invite',
    locale: resolved,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, esc(title))}
        ${name ? `<p>${esc(M.greeting.replace('{name}', name))}</p>` : ''}
        <p>${invitedBy ? esc(M.guestBody).replace('{organizer}', invitedBy) : esc(M.guestBodyAnonymous)}</p>
        ${when ? `<p><strong>${esc(M.when)}</strong> ${esc(when)}</p>` : ''}
        ${meetLink ? `<p><strong>${esc(M.link)}</strong> <a href="${meetLink}">${esc(meetLink)}</a></p>` : ''}
        ${when ? `
        <p style="margin-top: 20px;">${esc(M.rsvpAsk)}</p>
        <a href="${yes}" style="display:inline-block;background:#16a34a;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;margin-right:8px;">${esc(M.rsvpYes)}</a>
        <a href="${no}" style="display:inline-block;background:#dc2626;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;">${esc(M.rsvpNo)}</a>
        <p style="margin-top:16px;"><a href="${url}/rsvp/${rsvpToken}" style="color:${esc(brand.accent)};font-size:14px;">${esc(M.guestOpen)}</a></p>
        ` : ''}
        ${when ? `<p style="color:#9ca3af;font-size:12px;line-height:1.5;margin-top:20px;">
          ${
            invitedBy
              ? esc(T.guestZoneNoteOrganizer.replace('{zone}', zone)).replace('{name}', invitedBy)
              : esc(T.guestZoneNote.replace('{zone}', zone))
          }
        </p>` : ''}
        <p style="color:#9ca3af;font-size:12px;line-height:1.5;">
          ${esc(M.guestFooter)}
        </p>
      </div>
    `,
  });
}

// The bare address out of a From header, which may be "Name <addr>". The
// ORGANIZER line takes a mailto: value, so the display name has to come off.
function bareAddress(header: string): string {
  const angled = header.match(/<([^>]+)>/);
  return (angled ? angled[1] : header).trim();
}

// The calendar file that rides along with a meeting mail (#2015). METHOD:REQUEST
// is what makes a client treat it as an invitation rather than a read-only copy;
// the same header has to be repeated on the MIME part, because Outlook reads the
// content type and not the body. `.ics` generation itself stays in @/lib/ics —
// this only wraps it in the shape sendEmail's `attachments` takes.
//
// The length is buildMeetingIcs's 30-minute default: a Meeting has no stored
// duration yet (#1984). When it gains one, thread it through here.
//
// A REQUEST is an iTIP message, so it needs an ORGANIZER and an ATTENDEE or the
// clients ignore it (RFC 5546 §3.2.2): Gmail renders no invitation card without
// them, Outlook rejects a REQUEST with no organizer as an invalid meeting
// request, and a later CANCEL for the same UID can only be matched against the
// organizer that was stored. The deployment's own From address is the organizer
// — replies go nowhere useful, but RSVP is handled by the buttons in the mail
// body, not by iTIP. Both sides are optional: with no SMTP identity configured
// there is nothing to send anyway, and the file degrades to what it was before.
function meetingIcsAttachment(opts: {
  // The product of the world the mail is sent in (`productNameFor`).
  product: string;
  uid: string;
  title: string;
  start: Date;
  meetLink?: string | null;
  sequence?: number;
  // The recipient of the mail this rides on — the person whose calendar the
  // event lands in.
  attendeeEmail: string;
  attendeeName?: string | null;
  // Shown as the organizer's display name when the deployment has one.
  organizerName?: string | null;
}) {
  const organizerEmail = bareAddress(fromHeader(null, 'primary'));
  const ics = buildMeetingIcs({
    product: opts.product,
    uid: opts.uid,
    title: opts.title,
    start: opts.start,
    description: opts.meetLink ? `Join: ${opts.meetLink}` : null,
    location: opts.meetLink ?? null,
    method: 'REQUEST',
    sequence: opts.sequence,
    organizer: organizerEmail ? { email: organizerEmail, name: opts.organizerName } : null,
    attendee: { email: opts.attendeeEmail, name: opts.attendeeName },
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

// For the builders that predate per-org branding (#546): a default-world reader
// keeps the markup that mail always had, byte for byte (the same line the
// sender name draws, recipientSenderName); a reader of another world gets their
// own org's header and accent, never the internship blue (docs/worlds.md).
function worldHeading(brand: Awaited<ReturnType<typeof emailBrand>>, heading: string, legacy: string): string {
  return brand.vertical === DEFAULT_VERTICAL ? legacy : brandHeader(brand, heading);
}
function worldAccent(brand: Awaited<ReturnType<typeof emailBrand>>): string {
  return brand.vertical === DEFAULT_VERTICAL ? '#2563eb' : esc(brand.accent);
}

// Per-org brands for a cron pass over many organizations — one lookup per
// distinct org per run, never one brand for the whole batch (createOriginBook's
// rule, below).
function createBrandBook() {
  const brands = new Map<string, ReturnType<typeof emailBrand>>();
  return (orgId: string | null | undefined) => {
    const key = orgId ?? '';
    let hit = brands.get(key);
    if (!hit) brands.set(key, (hit = emailBrand(orgId ?? null)));
    return hit;
  };
}

// ── Which product does this mail's link open? (#2590) ───────────────────────
//
// One person can hold two accounts under one address — an internship account and
// a marketing account — and the host they sign in on decides which product they
// are in. A link in a mail is a promise about the same thing: the recipient
// clicks it and must land in the product THEIR account lives in. A marketing
// user who receives a password-reset, invitation, RSVP or "open your dashboard"
// link that points at the internship host lands on a sign-in page for a product
// they have no account in there (or, worse, on the wrong person's tenant).
//
// So a recipient-facing origin is never read off the environment at the call
// site again. It comes from one of the resolvers below, in this order of
// preference:
//
//   appUrlFor(orgId)          one recipient whose organization the builder knows
//                             (every builder that already takes `orgId` for its
//                             brand header). The world is the org's vertical.
//   appUrlForRecipient(...)   the same, falling back to the account behind a
//                             `userId` when the caller did not pass the org — so
//                             the many existing call sites that only hand over
//                             `userId` are correct without being touched.
//   createOriginBook()        the digest / reminder crons that loop over
//                             recipients of MANY organizations. It resolves the
//                             origin PER RECIPIENT from that recipient's own
//                             `orgId`, one query per DISTINCT org per run — never
//                             one origin per batch, which would stamp whoever
//                             came first onto everybody else's mail.
//   appUrl()                  the anonymous / identity-less default (no recipient
//                             account exists yet or at all: an applicant, a
//                             guest, an operator alert). INTERNSHIP, by design.
//
// BYTE-IDENTICAL FOR INTERNSHIP. For the INTERNSHIP world every resolver returns
// exactly what `appUrl()` returned before this change — not `originForWorld()`'s
// normalised form (which also strips a trailing slash and uses the configured
// origin as its fallback) — so a single-world deployment's mail does not change
// by a byte. Only a non-default world takes the new origin.
//
// A LOOKUP THAT FAILS FAILS LOUD. These resolvers do not swallow a database
// error and fall back to the internship origin: for the links a person cannot do
// without (reset, verification, invitation) a wrong-world link is worse than a
// mail that reports itself failed, and every caller already handles a throw from
// its builder. sendEmail's footer is no exception (see there).
function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

/** A world's origin. INTERNSHIP is the legacy `appUrl()` verbatim (see above). */
function appUrlForWorld(world: World): string {
  return world === DEFAULT_VERTICAL ? appUrl() : originForWorld(world);
}

/**
 * The origin for a mail addressed to a member of this organization. A missing
 * org (`null`/`undefined`) is the default org, i.e. the internship product.
 * Exported so a sender that lives outside this file (a route building its own
 * digest, the notification worker) resolves the origin the same way.
 */
export async function appUrlFor(orgId?: string | null): Promise<string> {
  if (!orgId) return appUrl();
  // One rule for every link into a tenant's product: its explicit public host
  // (#2495), else its world's origin (#2590) — src/lib/orgLinkOrigin.ts.
  return appOriginForOrg(orgId);
}

// The origin for the account behind a user id — for the senders whose callers
// hand over a `userId` and never told us the organization. One primary-key read.
async function appUrlForUser(userId: string | null | undefined): Promise<string> {
  if (!userId) return appUrl();
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { orgId: true } });
  return appUrlFor(row?.orgId);
}

/**
 * The origin for one recipient, from whatever the builder was given.
 *
 * `orgId` wins whenever it is an ANSWER — a string, or an explicit `null` (which
 * is the default org, i.e. INTERNSHIP). Only `undefined` ("the caller did not
 * say") sends us to the account behind `userId`; with neither, the mail is
 * identity-less and gets the default origin.
 */
async function appUrlForRecipient(orgId?: string | null, userId?: string | null): Promise<string> {
  if (orgId !== undefined) return appUrlFor(orgId);
  return appUrlForUser(userId);
}

// The product name for the same recipient `appUrlForRecipient` resolves.
async function productNameForRecipient(orgId?: string | null, userId?: string | null): Promise<string> {
  if (orgId === undefined && userId) {
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { orgId: true } });
    orgId = row?.orgId ?? null;
  }
  return productNameFor(await worldOfOrg(orgId));
}

/**
 * Per-recipient origins for a batch (a cron pass over many people).
 *
 * `urlFor(orgId)` is async and fills lazily, one query per distinct org per book;
 * `prefetch(orgIds)` warms many at once with a single query, which is what a
 * loop over hundreds of recipients should do first (`verticalsFor` is the
 * batched form of the same read). A book is created per RUN and never kept at
 * module scope: an organization whose product an admin just changed must show
 * up correctly in the next run, exactly like the newsletter's brand cache.
 */
function createOriginBook() {
  const origins = new Map<string, string>();
  const prefetch = async (orgIds: Iterable<string | null | undefined>): Promise<void> => {
    const missing = [...new Set([...orgIds].filter((id): id is string => !!id && !origins.has(id)))];
    if (missing.length === 0) return;
    const found = await appOriginsForOrgs(missing);
    // An organization that is not there (deleted, stale id) gets the default
    // origin — the single-org form's own fallback.
    for (const id of missing) origins.set(id, found.get(id) ?? appUrl());
  };
  const urlFor = async (orgId: string | null | undefined): Promise<string> => {
    if (!orgId) return appUrl();
    await prefetch([orgId]);
    return origins.get(orgId) ?? appUrl();
  };
  return { prefetch, urlFor };
}

// --- Which clock is this email on? (#1210) ----------------------------------

// Every emailed time is rendered on exactly one clock — the recipient's saved
// zone, or the deployment default when they have none — and until now nothing
// in the email said so. A reader whose zone was guessed wrong could not tell a
// wrong time from a wrong assumption about them, and had nowhere to go with it.
// This is the small print that closes the loop: name the zone, and link to the
// one place it can be corrected.
//
// Localised since #1720. It used to be deliberately English, on the grounds that
// a translated footer under an untranslated body reads as a bug — the bodies
// that carry it are translated now, so the rule points the other way: pass the
// same `locale` the body was rendered with. Omitting it still yields English,
// which is correct for the templates that have not been translated yet.
//
// `origin` (#2590): the account page it links to is the RECIPIENT'S product's,
// so the builder that already resolved the recipient's origin hands it over.
// Optional and trailing: the sync callers/specs that pass nothing keep the
// internship origin.
function timeZoneNote(timeZone?: string | null, locale?: string | null, origin?: string): string {
  const zone = resolveTimeZone(timeZone);
  const T = getDictionary(resolveLocale(locale)).notifications.emailTimes;
  return `<p style="color:#9ca3af;font-size:12px;line-height:1.5;margin-top:20px;">
    ${esc(T.zoneNote.replace('{zone}', zone))}
    <a href="${origin ?? appUrl()}/account#timezone" style="color:#9ca3af;text-decoration:underline;">${esc(T.zoneNoteLink)}</a>.
  </p>`;
}

// "in about 7 minutes" / "in about a minute", in the recipient's language.
// Turkish and German both need the singular to be a different sentence, not a
// stripped "s", so the two cases are separate keys rather than a suffix.
function inMinutesText(minutes: number, locale?: string | null): string {
  const T = getDictionary(resolveLocale(locale)).notifications.emailTimes;
  return minutes === 1 ? T.inOneMinute : T.inMinutes.replace('{n}', String(minutes));
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
  organizerName?: string | null,
  locale?: string | null
): string {
  if (!organizerTimeZone || sameWallClock(organizerTimeZone, recipientTimeZone, at)) return '';
  const loc = resolveLocale(locale);
  const T = getDictionary(loc).notifications.emailTimes;
  const who = organizerName
    ? esc(T.organizerTime.replace('{name}', organizerName))
    : esc(T.organizerTimeGeneric);
  return `<p style="color:#6b7280;font-size:14px;">${who}: ${formatInTimeZone(at, organizerTimeZone, { dateStyle: 'medium', timeStyle: 'short' }, dateLocale(loc))}</p>`;
}

// The same instant on everyone *else's* clock — one line per distinct clock, so
// a five-person project meeting spanning three zones prints three lines and not
// five. Only zones that actually differ from the reader's are listed: telling
// someone in Istanbul that it is also 17:00 in Istanbul for two colleagues adds
// nothing. Empty when the whole team reads the same time, which is the common
// case and should stay silent.
function participantClocks(
  at: Date,
  viewerTimeZone: string | null | undefined,
  others: ZonedPerson[],
  locale?: string | null
): string {
  const elsewhere = others.filter((p) => !sameWallClock(p.timezone, viewerTimeZone, at));
  if (elsewhere.length === 0) return '';
  const loc = resolveLocale(locale);
  const T = getDictionary(loc).notifications.emailTimes;
  // The readings themselves take the locale as well; a translated heading over
  // rows still reading "Thu, 10 Sept" is worse than leaving both in English.
  const rows = readingsByZone(at, elsewhere, dateLocale(loc))
    .map((r) => `<li>${esc(r.names.join(', '))} — ${esc(r.when)} (${esc(r.offsetLabel)})</li>`)
    .join('');
  return `<p style="color:#6b7280;font-size:14px;margin-bottom:4px;">${esc(T.others)}</p>
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
  // WORLDS (#2590): the CTA opens the product the RECIPIENT'S account lives in.
  const base = await appUrlForRecipient(orgId, userId);
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
        ${ctaBlock(brand, `${base}/portal`, 'Open your portal')}
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
  // WORLDS (#2590): the CTA opens the product the RECIPIENT'S account lives in.
  const base = await appUrlForRecipient(orgId, userId);
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
        ${ctaBlock(brand, `${base}/mentor`, 'Open your dashboard')}
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
  // WORLDS (#2590): the CTA opens the product the RECIPIENT'S account lives in.
  const base = await appUrlForRecipient(orgId, userId);
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
        ${ctaBlock(brand, `${base}/portal`, 'Open your portal')}
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
  // WORLDS (#2590): the CTA opens the product the RECIPIENT'S account lives in.
  const base = await appUrlForRecipient(orgId, userId);
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
        ${ctaBlock(brand, `${base}/admin/mentorship`, 'Review the request')}
      </div>
    `,
  });
}

// --- Re-match (#1801) -------------------------------------------------------
// Two mails, both localized to the recipient's own `User.preferredLanguage`.
//
// Neither one carries the mentee's reason code or their free-text note. The
// admin mail is a nudge to open the queue (the reason lives behind the ADMIN
// role, in the queue itself); the outgoing mentor's mail says the pairing ended
// and nothing more — a candid reason only stays candid if it is not read back
// by the person it is about.

export async function sendRematchRequestedEmail({
  to,
  adminName,
  menteeName,
  orgId,
  locale,
  userId,
}: {
  to: string;
  adminName?: string | null;
  menteeName: string;
  orgId?: string | null;
  /** The admin's User.preferredLanguage. */
  locale?: string | null;
  userId?: string | null;
}) {
  const brand = await emailBrand(orgId);
  // WORLDS (#2590): the CTA opens the product the RECIPIENT'S account lives in.
  const base = await appUrlForRecipient(orgId, userId);
  const resolved = resolveLocale(locale);
  const R = getDictionary(resolved).notifications.rematchRequestedEmail;
  await sendEmail({
    to,
    userId,
    category: 'mentorship-request',
    locale: resolved,
    fromName: brand.name,
    subject: R.subject.replace('{name}', menteeName),
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, esc(R.heading))}
        ${adminName ? `<p>${esc(R.greeting.replace('{name}', adminName))}</p>` : ''}
        <p>${esc(R.body.replace('{name}', menteeName))}</p>
        <p style="color:#6b7280;font-size:14px;">${esc(R.privacy)}</p>
        ${ctaBlock(brand, `${base}/admin/mentorship`, esc(R.cta))}
      </div>
    `,
  });
}

export async function sendRematchMentorNoticeEmail({
  to,
  mentorName,
  menteeName,
  orgId,
  locale,
  userId,
}: {
  to: string;
  mentorName?: string | null;
  menteeName: string;
  orgId?: string | null;
  /** The outgoing mentor's User.preferredLanguage. */
  locale?: string | null;
  userId?: string | null;
}) {
  const brand = await emailBrand(orgId);
  // WORLDS (#2590): the CTA opens the product the RECIPIENT'S account lives in.
  const base = await appUrlForRecipient(orgId, userId);
  const resolved = resolveLocale(locale);
  const R = getDictionary(resolved).notifications.rematchMentorEmail;
  await sendEmail({
    to,
    userId,
    category: 'mentorship-decision',
    locale: resolved,
    fromName: brand.name,
    subject: R.subject.replace('{name}', menteeName),
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, esc(R.heading))}
        ${mentorName ? `<p>${esc(R.greeting.replace('{name}', mentorName))}</p>` : ''}
        <p>${esc(R.body.replace('{name}', menteeName))}</p>
        <p>${esc(R.thanks)}</p>
        ${ctaBlock(brand, `${base}/mentor`, esc(R.cta))}
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

// The app's locale codes are 'en' | 'tr' | 'de'; Intl wants a BCP-47 tag. Every
// helper in lib/timezone.ts defaults to 'en-GB', and bare 'en' resolves to
// en-US — which would silently flip every English mail to "Sep 10, 2026, 5:00 PM"
// while the rest of the product writes 24-hour times. #1720 is about writing the
// mails in the recipient's language, not about re-formatting the English ones,
// so English keeps the tag it always had and only tr/de change.
function dateLocale(locale: Locale): string {
  return locale === 'en' ? 'en-GB' : locale;
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
  // WORLDS (#2590): a supplied `registerUrl` was built by the caller from the
  // applicant's org and is used as given. The "sign in" fallback (an existing
  // account promoted in place) is the promoted account's own product — its org,
  // or the account behind `userId` when the caller did not pass the org.
  const signInUrl = registerUrl ? null : `${await appUrlForRecipient(orgId, userId)}/auth/signin`;
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
        ${ctaBlock(brand, registerUrl || signInUrl!, isNewAccount ? M.approved.ctaRegister : M.approved.ctaSignIn)}
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
  // WORLDS (#2590): the CTA opens the product the RECIPIENT'S account lives in.
  const base = await appUrlForRecipient(orgId, userId);
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
        ${ctaBlock(brand, `${base}/portal`, M.sent.cta)}
      </div>
    `,
  });
}

// The trial reminder mail (#2415, copy from #2412, story #2392).
//
// Lives here rather than in the job for the reason `sendOfferSentEmail` does:
// the org brand header, the CTA block, `esc()` and `appUrl()` are this module's,
// and a second copy of them in src/lib/jobs would drift. The job keeps the
// DECISION (who, when, which threshold, and both preference gates); this
// function only renders and sends — the same split lib/offerNotify.ts already
// uses.
//
// ONE BODY, THREE SUBJECTS: the dictionary carries `subject7`/`subject3`/
// `subject0` over a single shared body, so the three marks cannot drift apart.
// The subject's number is always true because the selector fires on the exact
// calendar day (src/lib/trialReminderRule.ts), never as a catch-up on a later
// one. An unknown threshold falls back to the closest mark below it rather than
// inventing a fourth subject.
//
// Category `stage-deadline` — deliberately an EXISTING one (task_reminders in
// src/lib/emailGroups.ts). A trial reminder is the same kind of mail as the
// stage-deadline nudge ("this record needs you before a date"), and somebody who
// muted one meant to mute both. No new category, no new preference key.
export async function sendTrialReminderEmail({
  to,
  fullName,
  companyName,
  trialEndsAt,
  threshold,
  link,
  locale,
  orgId,
  userId,
}: {
  to: string;
  fullName: string;
  /** The account the trial belongs to. A proper noun — never translated. */
  companyName: string;
  trialEndsAt: Date;
  threshold: number;
  /** Deep link to the funnel record, already resolved for the recipient's role. */
  link: string;
  locale?: string | null;
  orgId?: string | null;
  userId?: string | null;
}) {
  const brand = await emailBrand(orgId);
  // WORLDS (#2590): the CTA opens the product the RECIPIENT'S account lives in.
  const base = await appUrlForRecipient(orgId, userId);
  const loc = resolveLocale(locale);
  const M = getDictionary(loc).trials;
  const subject = threshold >= 7 ? M.subject7 : threshold >= 3 ? M.subject3 : M.subject0;
  const endsOn = new Intl.DateTimeFormat(dateLocale(loc), { dateStyle: 'medium', timeZone: 'UTC' }).format(trialEndsAt);
  await sendEmail({
    to,
    userId,
    category: 'stage-deadline',
    locale,
    fromName: brand.name,
    subject: subject.replace('{company}', companyName),
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, esc(M.heading))}
        <p>${esc(M.greeting.replace('{name}', fullName))}</p>
        <p>${esc(M.body.replace('{company}', companyName).replace('{date}', endsOn))}</p>
        <p style="color:#666;font-size:13px;">${esc(M.hint)}</p>
        ${ctaBlock(brand, `${base}${link}`, esc(M.cta))}
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
  // WORLDS (#2590): the CTA opens the product the RECIPIENT'S account lives in.
  const base = await appUrlForRecipient(orgId, userId);
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
        ${ctaBlock(brand, `${base}/admin/candidates`, M.cta)}
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
  // WORLDS (#2590): the CTA opens the product the RECIPIENT'S account lives in. No userId here, so `orgId` is the whole answer (none ⇒ the default product).
  const base = await appUrlFor(orgId);
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
        ${ctaBlock(brand, `${base}/auth/signin`, M.cta)}
      </div>
    `,
  });
}

// The account owner's copy of an admin 2FA reset (#1543). Sent from the reset
// route, not left to a preference: their second factor is gone and somebody else
// removed it, so this is a disclosure rather than a notification — the same
// class as "an administrator accessed your account". It names the administrator,
// because "who did this" is the only question the owner actually has, and that
// is what turns an insider reset into something they can dispute.
export async function sendTwoFactorResetEmail({
  to,
  fullName,
  adminName,
  locale,
  orgId,
}: {
  to: string;
  fullName?: string | null;
  adminName: string;
  /** The account's User.preferredLanguage — the target's language, not the admin's (#1720). */
  locale?: string | null;
  orgId?: string | null;
}) {
  const brand = await emailBrand(orgId);
  // WORLDS (#2590): the CTA opens the product the RECIPIENT'S account lives in. No userId here, so `orgId` is the whole answer (none ⇒ the default product).
  const base = await appUrlFor(orgId);
  const resolved = resolveLocale(locale);
  const M = getDictionary(resolved).twoFactorResetEmail;
  return await sendEmail({
    to,
    fromName: brand.name,
    category: 'account',
    locale: resolved,
    subject: M.subject,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, esc(M.heading))}
        ${fullName ? `<p>${esc(M.greeting.replace('{name}', fullName))}</p>` : ''}
        <p>${esc(M.body.replace('{admin}', adminName))}</p>
        <p>${esc(M.reenrol)}</p>
        ${ctaBlock(brand, `${base}/account`, M.cta)}
        <p style="color: #6b7280; font-size: 14px;">${esc(M.notYou)}</p>
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
  // WORLDS (#2590): the CTA opens the product the RECIPIENT'S account lives in.
  const base = await appUrlForRecipient(orgId, userId);
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
        ${ctaBlock(brand, `${base}${link}`, 'Accept or decline')}
        ${when ? timeZoneNote(timeZone, undefined, base) : ''}
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
  // WORLDS (#2590): the CTA opens the product the RECIPIENT'S account lives in.
  const base = await appUrlForRecipient(orgId, userId);
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
        ${ctaBlock(brand, `${base}${link}`, 'Open the conversation')}
        ${when ? timeZoneNote(timeZone, undefined, base) : ''}
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
  marketplaces,
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
  // The MARKETING demo form's "marketplaces you sell on" (#2569).
  marketplaces?: string | null;
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
        ${marketplaces ? `<p>${esc(M.marketplaces)}: ${esc(marketplaces)}</p>` : ''}
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
  // WORLDS (#2590): the CTA opens the product the RECIPIENT'S account lives in.
  const base = await appUrlForRecipient(orgId, userId);
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
        ${ctaBlock(brand, `${base}/projects/${projectId}`, 'Review the request')}
      </div>
    `,
  });
}

export async function checkMentorInteractionReminders() {
  const days = parseInt(await getSetting('reminderDays'), 10) || 14;
  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - days);

  const allActive = await prisma.mentorshipRelation.findMany({
    where: { status: 'ACTIVE' },
    include: {
      mentor: true,
      mentee: true,
    },
  });
  // Mentorship work only (#2580 review): a vertical without the `mentorship`
  // module — a MARKETING sales book — gets neither this mail nor the bell, the
  // same line the sales attention queue draws by leaving `inactive` out.
  const capabilitiesOf = capabilitiesMemo();
  const activeRelations: typeof allActive = [];
  for (const relation of allActive) {
    if (interactionReminderApplies(await capabilitiesOf(relation.orgId))) activeRelations.push(relation);
  }

  // "Contact" is not "a row in InteractionLog": a mentor who is mid-thread with
  // a mentee in the app's messaging has been in touch, and nagging them to log
  // it is how this reminder taught mentors to ignore it. Same rule and same
  // implementation as the in-app attention queue (lib/lastContact.ts).
  const lastContacts = await getLastContacts(
    activeRelations.map((relation) => ({ id: relation.id, menteeId: relation.menteeId })),
  );

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
    })),
  );

  for (const relation of activeRelations) {
    if (dormant.has(relation.id)) continue;
    const lastContact = lastContacts.get(relation.id);
    const stale = !lastContact || lastContact.at < fourteenDaysAgo;
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

  // WORLDS (#2590): this job sweeps EVERY tenant with no session, and its
  // recipients are mentors of different products. The dashboard link is resolved
  // per MENTOR from that mentor's own organization (one batched read up front,
  // before anything is stamped) — never once for the run.
  const origins = createOriginBook();
  await origins.prefetch([...byMentor.values()].map((relations) => relations[0].mentor.orgId));

  let emailed = 0;
  for (const relations of byMentor.values()) {
    const mentor = relations[0].mentor;
    if (!mentor.email || !emailAllowed(mentor, 'deadlines') || !emailGroupAllowedForCategory(mentor, 'interaction-reminder')) continue;
    const base = await origins.urlFor(mentor.orgId);

    const rows = relations
      .map((relation) => {
        const lastDate = lastContacts.get(relation.id)?.at;
        const daysSince = lastDate
          ? Math.floor((Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24))
          : null;
        const since = daysSince !== null
          ? `${daysSince} day${daysSince === 1 ? '' : 's'} since the last contact`
          : 'no contact yet';
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
            <a href="${base}/mentor" style="
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
//
// PER RELATION HERE IS CORRECT, and that is a decision rather than an oversight
// (#2287 asked for it to be settled rather than left ambiguous). The cap the
// dormant and weekly-report sweeps had to fix was "one HUMAN, N identical
// messages": a mentee with two ACTIVE mentorships received the same mail twice.
// This sweep's recipient is the MENTOR, and each message is about a different
// mentee of theirs — same person, different content, no duplicate. Collapsing
// them would drop a deadline on the floor. The same reasoning covers
// checkMentorInteractionReminders above, which already batches a mentor's
// mentees into ONE mail with a list.
//
// The residual is a volume question, not a correctness one: a mentor with ten
// overdue relations gets ten mails in one tick. If that ever needs fixing it is
// a digest (batch this sweep by mentor the way the interaction reminder does),
// not a per-person cap — a cap would silently drop deadlines.
export async function checkStageDeadlineReminders() {
  const now = new Date();
  const TERMINAL = ['HIRED_660', 'EMPLOYED_700', 'INTERNSHIP_FOUND_ELSEWHERE_800'] as const;
  const capabilitiesOf = capabilitiesMemo();
  const brandOf = createBrandBook();

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
    // A MARKETING rep's record is /sales/leads/<id> (#2580); notificationLink
    // keeps /mentor/mentees/<id> for everyone else.
    const stageLink = notificationLink('MENTOR', 'relation', { relationId: rel.id }, { capabilities: await capabilitiesOf(rel.orgId) });
    await notifyIfAllowed(rel.mentorId, 'deadlines', 'deadline.stagePassed', { menteeName: rel.mentee.fullName }, stageLink);
    if (emailAllowed(rel.mentor, 'deadlines') && emailGroupAllowedForCategory(rel.mentor, 'stage-deadline')) {
      const preferredLanguage = rel.mentor.preferredLanguage ?? undefined;
      const locale = isLocale(preferredLanguage) ? preferredLanguage : defaultLocale;
      const emailText = getDictionary(locale).notifications.deadlineEmail;
      const subject = emailText.subject.replace('{mentee}', rel.mentee.fullName);
      const greeting = emailText.greeting.replace('{mentor}', rel.mentor.fullName);
      const body = emailText.body.replace('{mentee}', `<strong>${rel.mentee.fullName}</strong>`);
      await brandOf(rel.orgId).then((brand) => sendEmail({
        category: 'stage-deadline',
        userId: rel.mentorId,
        // The record's org — the same one that picks the bell's link above.
        orgId: rel.orgId,
        locale: rel.mentor.preferredLanguage,
        to: rel.mentor.email,
        subject,
        html: `${worldHeading(brand, esc(subject), '')}<p>${greeting}</p><p>${body}</p>`,
      })).catch((error) => {
        console.error('checkStageDeadlineReminders email failed:', { relationId: rel.id, mentorId: rel.mentorId, error });
      });
    }
    await prisma.mentorshipRelation.update({ where: { id: rel.id }, data: { deadlineReminderSentAt: now } });
  }

  // The owner's own follow-up dates (#2563) ride on this same job: the issue
  // asked for no second timer and no new notification category, and "a record
  // needs you on a date" is exactly what the 'deadlines' / 'stage-deadline'
  // pair already means (the trial ladder made the same call, #2412).
  const nextActions = await checkNextActionReminders(now);

  return { reminded: overdue.length, nextActions };
}

// Remind each owner once on the day of the next action they wrote on a record
// (#2563). The rule — calendar day in UTC, on-or-before today, caught up after
// a missed tick, re-armed only by moving the date — is lib/nextActionRule.ts.
//
// CLAIM FIRST, THEN SEND. The guard is a conditional `updateMany` on the exact
// date that was read (`nextActionAt` unchanged AND `nextActionRemindedAt`
// still null), the shape `checkStageDeadlineReminders` above lacks and the
// trial sweep's claim rows have: two overlapping ticks cannot both win, and an
// owner who moved the date between the read and the claim gets the NEW date's
// reminder on its own day rather than a stale one now. A failed mail after a
// won claim is not retried — the same trade the other sweeps make; the bell
// row is written first and the record reaches the attention queue the next
// day regardless, so the follow-up is not lost in silence.
//
// A failed BELL write is different: nothing reached the owner at all, so the
// claim is released (conditionally, on the exact stamp this tick wrote) and
// the next tick tries again, mail included. Every record runs in its own
// try/catch — one bad row must not skip the rest of the tick, nor reject the
// all-jobs `/api/cron` batch this sweep rides inside.
export async function checkNextActionReminders(now = new Date()) {
  const due = await prisma.mentorshipRelation.findMany({
    where: {
      status: 'ACTIVE',
      nextActionAt: { lt: nextActionDueBefore(now) },
      nextActionRemindedAt: null,
    },
    select: {
      id: true,
      orgId: true,
      menteeId: true,
      nextActionAt: true,
      nextActionNote: true,
      nextActionRemindedAt: true,
      company: { select: { name: true } },
      mentee: { select: { fullName: true } },
      mentor: {
        select: {
          id: true,
          role: true,
          orgId: true,
          email: true,
          fullName: true,
          emailNotifications: true,
          notificationPrefs: true,
          preferredLanguage: true,
        },
      },
    },
  });

  // WORLDS (#2590): the owner's own organization decides which product the
  // reminder's link opens. Read for the whole batch BEFORE the first claim below,
  // so a failure here costs nothing (no record has been marked reminded yet) and
  // the next tick simply tries again.
  const origins = createOriginBook();
  await origins.prefetch(due.map((rel) => rel.mentor.orgId));

  let reminded = 0;
  let failures = 0;
  const capabilitiesOf = capabilitiesMemo();
  const brandOf = createBrandBook();
  for (const rel of due) {
    if (!isNextActionReminderDue(rel, now)) continue;
    const claim = await prisma.mentorshipRelation.updateMany({
      where: { id: rel.id, nextActionAt: rel.nextActionAt, nextActionRemindedAt: null },
      data: { nextActionRemindedAt: now },
    });
    // Another tick won, or the owner changed the date in between. Quiet: one
    // of the contenders is supposed to lose.
    if (claim.count === 0) continue;
    const owner = rel.mentor;
    // What the bell and the mail call this record: the account for a funnel
    // record with a company, else the person — the trial sweep's fallback.
    const name = rel.company?.name ?? rel.mentee.fullName;
    const link = notificationLink(
      owner.role as NotificationRole,
      'relation',
      { relationId: rel.id, menteeId: rel.menteeId },
      { capabilities: await capabilitiesOf(rel.orgId) },
    );
    try {
      if (notificationCategoryAllowed(owner, 'deadlines')) {
        await notify(owner.id, 'deadline.nextActionDue', { name }, link);
      }
    } catch (error) {
      failures += 1;
      logger.error('Next action reminder bell failed', { relationId: rel.id, userId: owner.id, error: String(error) });
      // Give the reminder back so the next tick retries it. Conditional on our
      // own stamp: an owner who moved the date meanwhile already re-armed it.
      await prisma.mentorshipRelation
        .updateMany({
          where: { id: rel.id, nextActionAt: rel.nextActionAt, nextActionRemindedAt: now },
          data: { nextActionRemindedAt: null },
        })
        .catch((releaseError) => {
          logger.error('Next action reminder claim release failed', { relationId: rel.id, error: String(releaseError) });
        });
      continue;
    }
    reminded += 1;

    if (emailAllowed(owner, 'deadlines') && emailGroupAllowedForCategory(owner, 'stage-deadline')) {
      try {
        const locale = isLocale(owner.preferredLanguage ?? undefined) ? (owner.preferredLanguage as Locale) : defaultLocale;
        const text = getDictionary(locale).notifications.nextActionEmail;
        const noteHtml = rel.nextActionNote
          ? `<p><strong>${esc(text.noteLabel)}</strong> ${esc(rel.nextActionNote)}</p>`
          : '';
        const base = await origins.urlFor(owner.orgId);
        const brand = await brandOf(owner.orgId);
        const subject = text.subject.replace('{name}', name);
        await sendEmail({
          category: 'stage-deadline',
          userId: owner.id,
          orgId: owner.orgId,
          locale: owner.preferredLanguage,
          to: owner.email,
          subject,
          html: `${worldHeading(brand, esc(subject), '')}<p>${esc(text.greeting.replace('{owner}', owner.fullName))}</p><p>${esc(text.body.replace('{name}', name))}</p>${noteHtml}${
            brand.vertical === DEFAULT_VERTICAL
              ? `<p><a href="${base}${link}">${esc(text.cta)}</a></p>`
              : ctaBlock(brand, `${base}${link}`, esc(text.cta))
          }`,
        });
      } catch (error) {
        failures += 1;
        logger.error('Next action reminder email failed', { relationId: rel.id, userId: owner.id, error: String(error) });
      }
    }
  }

  return { checked: due.length, reminded, failures };
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
      mentee: { select: { id: true, orgId: true, fullName: true, email: true, preferredLanguage: true, emailNotifications: true, notificationPrefs: true } },
    },
  });
  if (relations.length === 0) return { checked: 0, reminded: 0, emailed: 0 };

  // ONE reminder per PERSON per week (#2287), not per relation. The eligibility
  // query returns a row per ACTIVE relation, so a mentee holding two of them
  // used to get two identical mails and two identical bell items every Friday,
  // indefinitely — the same defect as the dormant budget below, without the
  // "we will not write again" promise attached to it.
  //
  // The collapse happens BEFORE the claim, by picking one relation per mentee,
  // and the pick is deterministic (lowest id): two overlapping ticks then
  // choose the SAME relation, so the existing @@unique([relationId, weekStart])
  // settles the race atomically. Deduplicating after the claim would need a
  // unique on the person, which this change deliberately does not add yet (see
  // the schema comment on WeeklyReportReminder.recipientId).
  const byMentee = new Map<string, (typeof relations)[number]>();
  for (const relation of [...relations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (!byMentee.has(relation.mentee.id)) byMentee.set(relation.mentee.id, relation);
  }
  const candidates = [...byMentee.values()];

  // Someone already reminded this week through a DIFFERENT relation — one that
  // has since been completed, or simply a run that picked differently — must
  // not be reminded again. The relation-keyed unique cannot see that; the
  // recipient column is what makes the question answerable at all.
  const alreadyReminded = new Set(
    (
      await prisma.weeklyReportReminder.findMany({
        where: { weekStart, recipientId: { in: candidates.map((relation) => relation.mentee.id) } },
        select: { recipientId: true },
      })
    )
      .map((row) => row.recipientId)
      .filter((id): id is string => !!id)
  );

  const toRemind = candidates.filter((relation) => !alreadyReminded.has(relation.mentee.id));
  // WORLDS (#2590): each mentee's portal link is resolved from THAT mentee's own
  // organization (a Friday run reminds people of every tenant). Read before the
  // claims below, so a failed read leaves nobody claimed-but-unmailed.
  const origins = createOriginBook();
  await origins.prefetch(toRemind.map((relation) => relation.mentee.orgId));
  const claims = toRemind.map((relation) => ({ id: randomUUID(), relationId: relation.id, recipientId: relation.mentee.id, weekStart }));
  if (claims.length > 0) await prisma.weeklyReportReminder.createMany({ data: claims, skipDuplicates: true });
  const claimedIds = new Set((await prisma.weeklyReportReminder.findMany({ where: { id: { in: claims.map((claim) => claim.id) } }, select: { relationId: true } })).map((claim) => claim.relationId));
  let reminded = 0;
  let emailed = 0;
  for (const relation of toRemind) {
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
      const base = await origins.urlFor(relation.mentee.orgId);
      await sendEmail({
        to: relation.mentee.email, fromName: brand.name, category: 'weekly-report', subject: copy.reminderSubject,
        userId: relation.mentee.id, locale: relation.mentee.preferredLanguage,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">${brandHeader(brand, copy.reminderHeading)}<p>${copy.reminderGreeting.replace('{name}', esc(relation.mentee.fullName))}</p><p>${copy.reminderBody.replace('{date}', formattedWeek)}</p>${ctaBlock(brand, `${base}/portal`, copy.reminderCta)}</div>`,
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
        select: { id: true, orgId: true, fullName: true, email: true, preferredLanguage: true, emailNotifications: true, notificationPrefs: true },
      },
    },
    // Longest-dormant first, so a capped run always drains the oldest backlog
    // rather than a random slice of it.
    orderBy: { dormantSince: 'asc' },
  });

  let sent = 0;
  let checked = 0;

  // WORLDS (#2590): the check-in's button opens the product the MENTEE's account
  // lives in. Resolved from each mentee's own organization, read for the whole
  // batch before the first nudge is claimed (a claim spends one of the person's
  // two-ever budget, so nothing may fail between claiming and having the link).
  const origins = createOriginBook();
  await origins.prefetch(relations.map((relation) => relation.mentee.orgId));

  // THE CAP IS A PROMISE TO A PERSON, AND IT IS COUNTED PER PERSON (#2287).
  //
  // It is still SPENT on the relation (`dormantNudgeCount`, the atomic claim
  // below), because that is what makes two overlapping ticks safe. But what the
  // product owes is "at most two, ever, to this human, and the second one says
  // nobody will write again" — docs/dormant-first-contacts.md declares that
  // non-negotiable on sender-reputation grounds. A mentee holding two ACTIVE
  // mentorships holds two independent budgets, so read per relation the promise
  // breaks by a clean multiple: four mails, two of which already said there
  // would be no more.
  //
  // #2283 put an in-memory Set here. That deduplicates ONE TICK, which is not
  // the same thing: the second relation's budget is untouched, so the extra
  // mail is deferred to tomorrow's run rather than cancelled. The fix is to ask
  // the question of the person — the SUM of what their relations have spent,
  // and the LATEST nudge any of them sent, which is also the right clock for
  // the spacing rule. Both come out of rows that already exist, so this needs
  // no column and no migration.
  //
  // While "one mentee, at most one ACTIVE mentor" (#419) holds, the sum equals
  // the relation's own count and nothing here behaves differently. That is the
  // point: it is defence in depth, and it becomes load-bearing the day #1799
  // raises that limit above one deliberately.
  const menteeIds = [...new Set(relations.map((relation) => relation.mentee.id))];
  const spend = menteeIds.length
    ? await prisma.mentorshipRelation.groupBy({
        by: ['menteeId'],
        // ACTIVE only, matching the eligibility query: a completed mentorship's
        // spent budget is not a reason to stay silent in a new one.
        where: { menteeId: { in: menteeIds }, status: 'ACTIVE' },
        _sum: { dormantNudgeCount: true },
        _max: { dormantNudgeSentAt: true },
      })
    : [];
  const spentByMentee = new Map(spend.map((row) => [row.menteeId, row._sum.dormantNudgeCount ?? 0]));
  const lastNudgeByMentee = new Map(spend.map((row) => [row.menteeId, row._max.dormantNudgeSentAt]));
  for (const relation of relations) {
    if (sent >= DORMANT_NUDGE_MAX_PER_RUN) break;
    checked += 1;
    // The claim below is still guarded on THIS relation's own count; the
    // decision to send is made on the person's.
    const count = relation.dormantNudgeCount;
    const spent = spentByMentee.get(relation.mentee.id) ?? count;
    if (spent >= DORMANT_MAX_NUDGES) continue;
    const lastNudgeAt = lastNudgeByMentee.get(relation.mentee.id) ?? relation.dormantNudgeSentAt;
    if (spent > 0) {
      // Every nudge after the first is spaced from the one before it — the last
      // one this PERSON got, whichever relation sent it. This is also what
      // stops a second relation in the SAME run: the map is updated on the
      // claim, so the gap is zero days and the branch below refuses.
      if (!lastNudgeAt) continue;
      const days = Math.floor((now.getTime() - lastNudgeAt.getTime()) / DAY_MS);
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
    spentByMentee.set(relation.mentee.id, spent + 1);
    lastNudgeByMentee.set(relation.mentee.id, now);

    const locale = isLocale(relation.mentee.preferredLanguage ?? undefined)
      ? (relation.mentee.preferredLanguage as Locale)
      : defaultLocale;
    const copy = getDictionary(locale).dormantCheckIn;
    // "Final" is the person's last nudge, not the relation's.
    const isFinal = spent + 1 >= DORMANT_MAX_NUDGES;
    const brand = await emailBrand(relation.orgId);
    const base = await origins.urlFor(relation.mentee.orgId);
    await sendEmail({
      to: relation.mentee.email,
      fromName: brand.name,
      category: 'dormant-check-in',
      userId: relation.mentee.id,
      locale: relation.mentee.preferredLanguage,
      subject: copy.subject,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">${brandHeader(brand, copy.heading)}<p>${copy.greeting.replace('{name}', esc(relation.mentee.fullName))}</p><p>${isFinal ? copy.finalBody : copy.firstBody}</p><p style="color:#666;font-size:13px;">${copy.hint}</p>${ctaBlock(brand, `${base}/portal`, copy.cta)}</div>`,
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
    // #1720: the reminder is written per participant anyway (each side reads the
    // time on their own clock), so it reads the language on the same row.
    preferredLanguage: true,
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
      // A cancelled meeting (#1980) is not reminded about. Moving one clears
      // `reminderSentAt`, so the new time gets its own reminder from here.
      status: 'SCHEDULED',
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

  // WORLDS (#2590): the reminder's button and time-zone link open the product
  // each PARTICIPANT's account lives in. The two sides of a relation are
  // normally the same organization, but the origin is resolved per participant
  // from their own `orgId` (one batched read for the whole tick, before any
  // meeting is claimed) rather than assumed from the first one.
  const origins = createOriginBook();
  await origins.prefetch(
    meetings.flatMap((m) => [m.relation?.mentee?.orgId, m.relation?.mentor?.orgId]),
  );
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
      // LOCALE (#1720): the recipient is a signed-up participant, so the
      // language is their own stored preference — for the mail below and for
      // the date it is about. Resolved up here because the in-app notification
      // carries the same pre-rendered string and is addressed to the same
      // person.
      const uLocale = resolveLocale(user.preferredLanguage);
      // Per participant: the two sides of a relation can sit in different zones,
      // and each must read the time on their own clock (#1030).
      const when = formatInTimeZone(m.scheduledAt!, user.timezone, undefined, dateLocale(uLocale));
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
        const base = await origins.urlFor(user.orgId);
        const R = getDictionary(uLocale).notifications.meetingReminderEmail;
        const [bodyBefore, bodyAfter = ''] = R.body.split('{title}');
        await sendEmail({
          category: 'meeting-reminder',
          userId: user.id,
          to: user.email,
          fromName: brand.name,
          locale: uLocale,
          subject: R.subject.replace('{title}', m.title),
          html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            ${brandHeader(brand, esc(R.heading))}
            <p>${esc(R.greeting.replace('{name}', user.fullName ?? ''))}</p>
            <p>${esc(bodyBefore)}<strong>${esc(m.title)}</strong>${esc(bodyAfter)}</p>
            <p><strong>${esc(R.when)}</strong> ${when} (${esc(inMinutesText(minutes, uLocale))})</p>
            ${participantClocks(
              m.scheduledAt!,
              user.timezone,
              participants.filter((p) => p.id !== user.id).map((p) => ({ name: p.fullName, timezone: p.timezone })),
              uLocale
            )}
            ${m.meetLink ? `<p><strong>${esc(R.link)}</strong> <a href="${m.meetLink}">${esc(m.meetLink)}</a></p>` : ''}
            ${ctaBlock(brand, `${base}${link}`, esc(R.cta))}
            ${timeZoneNote(user.timezone, uLocale, base)}
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
          // LOCALE (#1720): a MeetingGuest has no account and therefore no
          // preference. The mentor side of the relation is the person who
          // scheduled this and typed the address in, so their language is the
          // best evidence there is — the same rule the guest INVITE follows.
          locale: m.relation.mentor?.preferredLanguage,
          // …and whose product this is: the organizer's world, as for the invite.
          orgId: m.relation.orgId ?? m.relation.mentor?.orgId ?? null,
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
  locale,
  orgId,
}: {
  to: string;
  name?: string | null;
  title: string;
  scheduledAt: Date;
  meetLink?: string | null;
  organizerTimeZone?: string | null;
  minutes: number;
  /** The organizer's language — a guest has none of their own (#1720). */
  locale?: string | null;
  /** The organizer's organization — a guest has no world of their own either. */
  orgId?: string | null;
}) {
  const zone = resolveTimeZone(organizerTimeZone);
  const resolved = resolveLocale(locale);
  const when = `${formatInTimeZone(scheduledAt, zone, undefined, dateLocale(resolved))} (${zoneLabel(scheduledAt, zone)})`;
  const R = getDictionary(resolved).notifications.meetingReminderEmail;
  const [bodyBefore, bodyAfter = ''] = R.body.split('{title}');
  const brand = await emailBrand(orgId);
  await sendEmail({
    to,
    // Names the sender after the organizer's org outside the default world.
    orgId: orgId ?? null,
    // no-user-row: the reminder half of the guest invite, addressed to the same
    // account-less MeetingGuest — and it already stops on its own when the guest
    // declines, which is the only "opt out" that address can express.
    category: 'meeting-guest-reminder',
    locale: resolved,
    subject: R.subject.replace('{title}', title),
    html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      ${worldHeading(brand, esc(R.heading), '')}
      ${name ? `<p>${esc(R.greeting.replace('{name}', name))}</p>` : ''}
      <p>${esc(bodyBefore)}<strong>${esc(title)}</strong>${esc(bodyAfter)}</p>
      <p><strong>${esc(R.when)}</strong> ${esc(when)} (${esc(inMinutesText(minutes, resolved))})</p>
      ${meetLink ? `<p><strong>${esc(R.link)}</strong> <a href="${meetLink}">${esc(meetLink)}</a></p>` : ''}
      <p style="color:#9ca3af;font-size:12px;line-height:1.5;margin-top:20px;">
        ${esc(R.guestFooter)}
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
  // WORLDS (#2590): a project team can span organizations' products only in
  // principle, but the link is still resolved per TEAM MEMBER from their own
  // `orgId` — one book for the whole tick, one query per distinct org.
  const origins = createOriginBook();

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
        orgId: true,
        email: true,
        fullName: true,
        role: true,
        emailNotifications: true,
        notificationPrefs: true,
        timezone: true,
        // #1720: same rule as the per-relation reminder — the mail is already
        // rendered once per team member, so it reads their language too.
        preferredLanguage: true,
      },
    });
    if (recipients.length === 0) continue;
    // Before the occurrence is claimed below, so a failed read leaves the
    // occurrence unclaimed and the next quarter-hour tick reminds the team.
    await origins.prefetch(recipients.map((r) => r.orgId));

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
        // LOCALE (#1720): a project team member is a signed-up User, so their
        // own stored preference decides — for the occurrence's date as much as
        // for the sentence around it, and for the in-app copy of the same line.
        const uLocale = resolveLocale(user.preferredLanguage);
        const whenLocal = formatInTimeZone(when, user.timezone, undefined, dateLocale(uLocale));
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
          const base = await origins.urlFor(user.orgId);
          const S = getDictionary(uLocale).notifications.meetingSeriesReminderEmail;
          // Two sentences, because the project name is only appended when there
          // is one — and in Turkish and German that is not a suffix you can bolt
          // on to the end of the translated sentence.
          const template = projectName ? S.bodyWithProject : S.body;
          const [bodyBefore, bodyRest = ''] = template.split('{title}');
          const [bodyMiddle, bodyAfter = ''] = bodyRest.split('{project}');
          await sendEmail({
            // Split out of 'meeting-reminder' so the recurring project blast is
            // distinguishable in the delivery log; same group either way.
            category: 'meeting-series-reminder',
            userId: user.id,
            to: user.email,
            fromName: brand.name,
            locale: uLocale,
            subject:
              lead === 'HOUR_BEFORE'
                ? S.subjectSoon.replace('{title}', series.title)
                : S.subjectTomorrow.replace('{title}', series.title).replace('{project}', projectName),
            html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              ${brandHeader(brand, esc(S.heading))}
              <p>${esc(S.greeting.replace('{name}', user.fullName ?? ''))}</p>
              <p>${esc(bodyBefore)}<strong>${esc(series.title)}</strong>${esc(bodyMiddle)}${projectName ? esc(projectName) : ''}${esc(bodyAfter)}</p>
              <p><strong>${esc(S.when)}</strong> ${whenLocal}</p>
              ${participantClocks(
                when,
                user.timezone,
                recipients.filter((r) => r.id !== user.id).map((r) => ({ name: r.fullName, timezone: r.timezone })),
                uLocale
              )}
              ${series.fixedLink ? `<p><strong>${esc(S.link)}</strong> <a href="${series.fixedLink}">${esc(series.fixedLink)}</a></p>` : ''}
              ${ctaBlock(brand, `${base}${link}`, esc(S.cta))}
              ${timeZoneNote(user.timezone, uLocale, base)}
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
      orgId: true,
      email: true,
      fullName: true,
      emailNotifications: true,
      notificationPrefs: true,
      // #1720: this select did not fetch the language at all — the real bug
      // behind "the digest is always English". It does now.
      preferredLanguage: true,
      mentorRelations: {
        select: {
          id: true,
          menteeId: true,
          startDate: true,
          meetings: { where: { scheduledAt: { gt: now, lte: in7d } }, select: { id: true } },
        },
      },
    },
  });

  // One grouped read for every mentor's relations rather than one per mentor —
  // and the same definition of contact the attention queue uses, so the digest
  // and the dashboard cannot disagree about who is stale (lib/lastContact.ts).
  const lastContacts = await getLastContacts(
    mentors.flatMap((m) => m.mentorRelations.map((r) => ({ id: r.id, menteeId: r.menteeId }))),
  );

  // WORLDS (#2590): one digest per mentor across EVERY tenant, so the dashboard
  // button is resolved per mentor from that mentor's own organization — a
  // marketing-world mentor's digest must not send them to the internship host.
  const origins = createOriginBook();
  await origins.prefetch(mentors.map((m) => m.orgId));
  const capabilitiesOf = capabilitiesMemo();
  const brandOf = createBrandBook();

  let sent = 0;
  for (const m of mentors) {
    if (m.mentorRelations.length === 0) continue;
    if (!emailAllowed(m, 'digest') || !emailGroupAllowedForCategory(m, 'mentor-digest')) continue;
    // Mentorship work (stale mentees, /mentor): a sales rep is a MENTOR row
    // with a book of leads, and gets no mentoring summary — skipped, not
    // re-branded, as checkMentorInteractionReminders does.
    if (!interactionReminderApplies(await capabilitiesOf(m.orgId))) continue;
    const stale = m.mentorRelations.filter((r) => {
      const contact = lastContacts.get(r.id);
      return !contact || contact.at < fourteenDaysAgo;
    }).length;
    const upcoming = m.mentorRelations.reduce((n, r) => n + r.meetings.length, 0);
    const newApplications = m.mentorRelations.filter((r) => r.startDate >= weekAgo).length;

    // LOCALE (#1720): the recipient is a registered mentor, so their stored
    // `preferredLanguage` decides — no other source is needed or wanted.
    const mLocale = resolveLocale(m.preferredLanguage);
    const D = getDictionary(mLocale).notifications.mentorDigestEmail;
    // The count is bolded, so each line is split on its {n} rather than
    // replaced — the number is not at the same position in all three languages.
    const countLine = (template: string, n: number) => {
      const [before, after = ''] = template.split('{n}');
      return `<li>${esc(before)}<strong>${n}</strong>${esc(after)}</li>`;
    };
    try {
      const base = await origins.urlFor(m.orgId);
      const brand = await brandOf(m.orgId);
      await sendEmail({
        category: 'mentor-digest',
        userId: m.id,
        orgId: m.orgId,
        to: m.email,
        locale: mLocale,
        subject: D.subject,
        html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          ${worldHeading(brand, esc(D.heading), `<h2 style="color:#2563eb;">${esc(D.heading)}</h2>`)}
          <p>${esc(D.greeting.replace('{name}', m.fullName))}</p>
          <ul>
            ${countLine(D.stale, stale)}
            ${countLine(D.upcoming, upcoming)}
            ${countLine(D.newApplications, newApplications)}
          </ul>
          <a href="${base}/mentor" style="display:inline-block;background:${worldAccent(brand)};color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;">${esc(D.cta)}</a>
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
function activityDigestTable(items: MenteeActivity[], locale?: string | null): string {
  const A = getDictionary(resolveLocale(locale)).notifications.activityDigestEmail;
  const rows = items
    .map((m) => {
      const login =
        m.daysSinceLogin === null
          ? A.loginNever
          : m.daysSinceLogin <= 0
            ? A.loginToday
            : A.loginDaysAgo.replace('{n}', String(m.daysSinceLogin));
      const flag = m.daysSinceLogin !== null && m.daysSinceLogin >= 7 ? ' ⚠️' : '';
      // NOT lib/activityReport.ts § formatDuration: that one hardcodes "2h 5m",
      // which is the last English left in an otherwise translated row (#1720).
      // Same arithmetic, dictionary units.
      const hours = Math.floor(m.timeOnSiteSec / 3600);
      const mins = Math.round((m.timeOnSiteSec % 3600) / 60);
      const onSite = `${
        hours > 0
          ? A.onSiteHours.replace('{h}', String(hours)).replace('{m}', String(mins))
          : A.onSiteMinutes.replace('{m}', String(mins))
      } · ${A.onSitePages.replace('{n}', String(m.pageViews))}`;
      return `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${m.menteeName}${flag}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${esc(login)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${esc(onSite)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${m.goalsCompleted}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${m.interactions}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${m.meetings}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${m.pipelineChanges}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${m.messagesSent}/${m.messagesReceived}</td>
      </tr>`;
    })
    .join('');
  const C = A.columns;
  return `<table style="border-collapse:collapse;width:100%;font-size:13px;">
    <thead><tr style="text-align:left;color:#6b7280;">
      <th style="padding:6px 8px;">${esc(C.mentee)}</th><th style="padding:6px 8px;">${esc(C.login)}</th>
      <th style="padding:6px 8px;">${esc(C.onSite)}</th><th style="padding:6px 8px;">${esc(C.goals)}</th>
      <th style="padding:6px 8px;">${esc(C.interactions)}</th><th style="padding:6px 8px;">${esc(C.meetings)}</th>
      <th style="padding:6px 8px;">${esc(C.stage)}</th><th style="padding:6px 8px;">${esc(C.messages)}</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// The overdue to-dos that ride ALONG with the daily digest (#2440).
//
// It is a block in a mail that is already going out — no new send, no new
// recipient, nothing mailed *because* a to-do is late. What counts as late is
// src/lib/taskDue.ts's answer and not a `lt: new Date()` written here: a to-do
// due TODAY is not late, and `overdueBefore()` is that rule as a query bound.
//
// The caller passes the reach: a mentor's own mentees by id, an admin's
// organisation by orgId — ProjectTask carries no orgId of its own and this runs
// in a cron with no tenant context, so the scope has to be said out loud. Reach
// is not permission, though: within it the same privacy rule applies that
// /api/todos applies to a page, and it is the one in src/lib/todoVisibility.ts.
const OVERDUE_DIGEST_LIMIT = 10;
// How far down the late-to-do list the block looks before it prints the first
// ten. The privacy filter below runs in JS — it compares two columns of the same
// row — so the query has to bring back more than it prints, or ten private lines
// at the top would hide the eleventh, readable one. It also makes "and N more"
// an actual count instead of the "and 1 more" that `take: LIMIT + 1` could say.
const OVERDUE_DIGEST_SCAN = 100;

async function overdueTodoBlock(
  reach: Prisma.ProjectTaskWhereInput,
  locale: Locale,
  recipientId: string,
  withHeading = true
): Promise<string> {
  const rows = await prisma.projectTask.findMany({
    where: { ...reach, done: false, archivedAt: null, dueDate: { lt: overdueBefore() } },
    orderBy: { dueDate: 'asc' },
    take: OVERDUE_DIGEST_SCAN,
    select: {
      id: true,
      title: true,
      dueDate: true,
      // The three columns the privacy rule reads (src/lib/todoVisibility.ts).
      projectId: true,
      createdById: true,
      assigneeId: true,
      assignee: { select: { fullName: true } },
    },
  });
  // A line somebody wrote for themselves on their own list is theirs: /api/todos
  // hides it from their mentor and from an admin alike, and a mail may not carry
  // what no page will show. Same predicate as the team list, one copy (#2440).
  const visible = visibleToViewer(rows, recipientId);
  if (visible.length === 0) return '';
  const A = getDictionary(locale).notifications.activityDigestEmail;
  const items = visible
    .slice(0, OVERDUE_DIGEST_LIMIT)
    .map((row) => {
      const line = A.overdueLine
        .replace('{name}', row.assignee?.fullName ?? '')
        .replace('{title}', row.title)
        // The stored value names a UTC day (src/lib/taskDue.ts § rule 2).
        .replace('{date}', row.dueDate ? formatDate(row.dueDate, locale, { timeZone: 'UTC' }) : '');
      return `<li style="margin:2px 0;">${esc(line)}</li>`;
    })
    .join('');
  const rest = visible.length > OVERDUE_DIGEST_LIMIT
    ? `<p style="color:#6b7280;font-size:12px;">${esc(A.overdueMore.replace('{n}', String(visible.length - OVERDUE_DIGEST_LIMIT)))}</p>`
    : '';
  const heading = withHeading
    ? `<h3 style="margin:20px 0 6px;color:#b91c1c;font-size:15px;">${esc(A.overdueHeading)}</h3>`
    : '';
  return `${heading}
    <ul style="margin:0;padding-left:18px;font-size:13px;color:#374151;">${items}</ul>${rest}`;
}

type DigestRecipient = {
  id: string;
  orgId: string | null;
  email: string;
  fullName: string;
  preferredLanguage: string | null;
};

// What an org without mentorship gets instead of the daily digest: the overdue
// to-dos alone, in its own brand and linking to /todos — /todos is not a
// mentorship feature, and this digest was the only mail that reminded anyone.
async function sendOverdueTodoMail(
  u: DigestRecipient,
  reach: Prisma.ProjectTaskWhereInput,
  base: string,
  brand: Awaited<ReturnType<typeof emailBrand>>
): Promise<boolean> {
  const locale = resolveLocale(u.preferredLanguage);
  const block = await overdueTodoBlock(reach, locale, u.id, false);
  if (!block) return false;
  const A = getDictionary(locale).notifications.activityDigestEmail;
  await sendEmail({
    category: 'activity-digest',
    userId: u.id,
    orgId: u.orgId,
    to: u.email,
    locale: u.preferredLanguage,
    subject: A.todoSubject,
    html: `<div style="font-family: Arial, sans-serif; max-width: 680px; margin: 0 auto;">
      ${worldHeading(brand, esc(A.todoSubject), `<h2 style="color:#2563eb;">${esc(A.todoSubject)}</h2>`)}
      <p>${esc(A.todoGreeting.replace('{name}', u.fullName))}</p>
      ${block}
      <p style="margin-top:16px;"><a href="${base}/todos" style="display:inline-block;background:${worldAccent(brand)};color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;">${esc(A.todoCta)}</a></p>
    </div>`,
  });
  return true;
}

// Daily mentee-activity digest. Each mentor gets a summary of THEIR mentees'
// activity in the last 24h; each admin gets their own org's summary. Respects the
// 'digest' email preference. Recipients with no mentees / no data are skipped.
export async function sendDailyActivityDigests() {
  const now = new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  let sent = 0;

  const mentors = await prisma.user.findMany({
    where: { role: 'MENTOR', isActive: true },
    // #1720: `preferredLanguage` was missing here too — every recipient of this
    // digest is a registered user, so their own preference is the whole answer.
    select: { id: true, orgId: true, email: true, fullName: true, emailNotifications: true, notificationPrefs: true, preferredLanguage: true },
  });
  // WORLDS (#2590): both digests below go to people of EVERY tenant, so the
  // button is resolved per recipient from that recipient's own organization —
  // never one origin for the batch.
  const origins = createOriginBook();
  await origins.prefetch(mentors.map((m) => m.orgId));
  // Mentee activity is mentorship work: an org without the module (a MARKETING
  // sales book) gets neither half of this digest — skipped, not re-branded —
  // and only the overdue to-dos of the same reach (sendOverdueTodoMail).
  const capabilitiesOf = capabilitiesMemo();
  const brandOf = createBrandBook();
  for (const m of mentors) {
    if (!emailAllowed(m, 'digest') || !emailGroupAllowedForCategory(m, 'activity-digest')) continue;
    if (!interactionReminderApplies(await capabilitiesOf(m.orgId))) {
      try {
        const leads = await prisma.mentorshipRelation.findMany({ where: { mentorId: m.id }, select: { menteeId: true } });
        if (leads.length === 0) continue;
        const reach = { assigneeId: { in: leads.map((l) => l.menteeId) } };
        if (await sendOverdueTodoMail(m, reach, await origins.urlFor(m.orgId), await brandOf(m.orgId))) sent++;
      } catch (e) {
        console.error('Overdue to-do mail failed:', e);
      }
      continue;
    }
    const items = await getMentorMenteeActivity(m.id, since);
    if (items.length === 0) continue;
    const mLocale = resolveLocale(m.preferredLanguage);
    const A = getDictionary(mLocale).notifications.activityDigestEmail;
    // Their own mentees, the same people the table above is about.
    const overdue = await overdueTodoBlock(
      { assigneeId: { in: items.map((i) => i.menteeId) } },
      mLocale,
      m.id
    );
    try {
      const base = await origins.urlFor(m.orgId);
      const brand = await brandOf(m.orgId);
      await sendEmail({
        category: 'activity-digest',
        userId: m.id,
        orgId: m.orgId,
        to: m.email,
        locale: mLocale,
        subject: A.subject,
        html: `<div style="font-family: Arial, sans-serif; max-width: 680px; margin: 0 auto;">
          ${worldHeading(brand, esc(A.heading), `<h2 style="color:#2563eb;">${esc(A.heading)}</h2>`)}
          <p>${esc(A.greetingMentor.replace('{name}', m.fullName))}</p>
          ${activityDigestTable(items, mLocale)}
          ${overdue}
          <p style="margin-top:16px;"><a href="${base}/mentor/mentee-activity" style="display:inline-block;background:${worldAccent(brand)};color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;">${esc(A.cta)}</a></p>
          <p style="color:#9ca3af;font-size:12px;">${esc(A.trackingNote)}</p>
        </div>`,
      });
      sent++;
    } catch (e) {
      console.error('Mentor activity digest failed:', e);
    }
  }

  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN', isActive: true },
    select: { id: true, orgId: true, email: true, fullName: true, emailNotifications: true, notificationPrefs: true, preferredLanguage: true },
  });
  // One table PER ORG, never one for the installation: this cron binds no
  // tenant context, and the unscoped read listed every tenant's mentees, both
  // worlds, in every admin's mail. A NULL-org admin is the default org's.
  const itemsByOrg = new Map<string, Promise<MenteeActivity[]>>();
  const fallbackOrg = admins.some((a) => !a.orgId) ? await defaultOrgId() : null;
  const orgItems = (orgId: string) => {
    let hit = itemsByOrg.get(orgId);
    if (!hit) itemsByOrg.set(orgId, (hit = orgWhere(orgId).then((tenant) => getSystemMenteeActivity(since, tenant))));
    return hit;
  };
  await origins.prefetch(admins.map((a) => a.orgId));
  for (const a of admins) {
    if (!emailAllowed(a, 'digest') || !emailGroupAllowedForCategory(a, 'activity-digest')) continue;
    if (!interactionReminderApplies(await capabilitiesOf(a.orgId))) {
      if (!a.orgId) continue;
      try {
        const reach = { assignee: { is: { orgId: a.orgId } } };
        if (await sendOverdueTodoMail(a, reach, await origins.urlFor(a.orgId), await brandOf(a.orgId))) sent++;
      } catch (e) {
        console.error('Overdue to-do mail failed:', e);
      }
      continue;
    }
    const adminItems = await orgItems(a.orgId ?? fallbackOrg!);
    if (adminItems.length === 0) continue;
    const aLocale = resolveLocale(a.preferredLanguage);
    const A = getDictionary(aLocale).notifications.activityDigestEmail;
    // Their own organisation. An admin with no org reads nobody's to-dos here
    // rather than everybody's: this job binds no tenant context.
    const overdue = a.orgId
      ? await overdueTodoBlock({ assignee: { is: { orgId: a.orgId } } }, aLocale, a.id)
      : '';
    try {
      const base = await origins.urlFor(a.orgId);
      const brand = await brandOf(a.orgId);
      await sendEmail({
        category: 'activity-digest',
        userId: a.id,
        orgId: a.orgId,
        to: a.email,
        locale: aLocale,
        subject: A.subjectAll,
        html: `<div style="font-family: Arial, sans-serif; max-width: 680px; margin: 0 auto;">
          ${worldHeading(brand, esc(A.heading), `<h2 style="color:#2563eb;">${esc(A.heading)}</h2>`)}
          <p>${esc(A.greetingAdmin.replace('{name}', a.fullName))}</p>
          ${activityDigestTable(adminItems, aLocale)}
          ${overdue}
          <p style="margin-top:16px;"><a href="${base}/admin/mentee-activity" style="display:inline-block;background:${worldAccent(brand)};color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;">${esc(A.cta)}</a></p>
        </div>`,
      });
      sent++;
    } catch (e) {
      console.error('Admin activity digest failed:', e);
    }
  }

  return { mentors: mentors.length, admins: admins.length, sent };
}

// A cron's admin summary, per org: `counts` maps an org id to what happened in
// it, and only that org's active admins hear its number. A bare
// `{ role: 'ADMIN' }` is every admin of every tenant in both worlds, with the
// installation-wide count (docs/worlds.md). NULL-org rows are the caller's to
// fold into the default org.
async function notifyOrgAdmins(
  counts: Map<string, number>,
  send: (admin: { id: string }, count: number) => Promise<unknown>,
): Promise<void> {
  for (const [orgId, count] of counts) {
    const admins = await prisma.user.findMany({
      where: { AND: [{ role: 'ADMIN', isActive: true }, await orgWhere(orgId)] },
      select: { id: true },
    });
    await Promise.all(admins.map((a) => send(a, count)));
  }
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

  const users = await prisma.user.findMany({
    where: {
      role: 'MENTEE',
      consentAt: { not: null, lt: dueCutoff },
      retentionReminderSentAt: null,
    },
    select: { id: true, orgId: true, fullName: true, email: true },
  });

  // WORLDS (#2590): the renewal link opens the product the CANDIDATE's account
  // lives in — a legal notice that lands on a site where the person has no
  // account cannot be acted on, and this job sweeps every tenant. Resolved from
  // each candidate's own organization, read for the batch BEFORE the first
  // `retentionReminderSentAt` stamp so a failed read stamps nobody.
  const origins = createOriginBook();
  await origins.prefetch(users.map((u) => u.orgId));
  const brandOf = createBrandBook();
  // Per org: each tenant's admins hear about their own candidates only.
  const remindedByOrg = new Map<string, number>();
  const fallbackOrg = users.some((u) => !u.orgId) ? await defaultOrgId() : null;

  let reminded = 0;
  for (const u of users) {
    const renewUrl = `${await origins.urlFor(u.orgId)}/consent/renew?token=${makeConsentRenewToken(u.id)}`;
    // Legal/retention notice — always sent (not gated by marketing opt-out).
    try {
      const brand = await brandOf(u.orgId);
      const heading = 'Do you want to keep your data with us?';
      await sendEmail({
        category: 'retention-reminder',
        to: u.email,
        // No userId (essential mail, no footer), so the org names the sender.
        orgId: u.orgId,
        subject: 'Please confirm you still want us to keep your data',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            ${worldHeading(brand, heading, `<h2 style="color:#2563eb;">${heading}</h2>`)}
            <p>Hi ${u.fullName},</p>
            <p>It has been more than ${months} months since you agreed to us storing your
            data (${brand.vertical === DEFAULT_VERTICAL ? 'profile, CV and interaction history' : 'profile and activity history'}). To keep it, please confirm below.
            If you don't, an administrator will review your record for deletion.</p>
            <a href="${renewUrl}" style="display:inline-block;background:${worldAccent(brand)};color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;margin:16px 0;">Keep my data</a>
            <p style="color:#6b7280;font-size:12px;">You can also download or delete your data anytime from Account settings.</p>
          </div>`,
      });
    } catch (e) {
      console.error('checkRetentionReminders email failed:', { userId: u.id, error: e });
    }
    await notify(u.id, 'retention.confirm', {}, `/consent/renew?token=${makeConsentRenewToken(u.id)}`);
    await prisma.user.update({ where: { id: u.id }, data: { retentionReminderSentAt: new Date() } });
    reminded += 1;
    const org = u.orgId ?? fallbackOrg!;
    remindedByOrg.set(org, (remindedByOrg.get(org) ?? 0) + 1);
  }

  // Let each org's admins know how many of THEIR candidates are up for review.
  await notifyOrgAdmins(remindedByOrg, (a, count) =>
    notify(a.id, 'retention.adminSummary', { count }, '/admin/retention'),
  );

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
  const people = await dueForReminder();

  // WORLDS (#2590): the one-click "leave the pool" link opens the product the
  // PERSON's account lives in. `dueForReminder()` selects no organization, so it
  // is read here for the whole batch in one query (not one per person), and the
  // origin is resolved per person from it — before the first `reEngageNotifiedAt`
  // stamp, so a failed read stamps nobody.
  const orgOf = new Map<string, string | null>(
    people.length
      ? (
          await prisma.user.findMany({
            where: { id: { in: people.map((p) => p.id) } },
            select: { id: true, orgId: true },
          })
        ).map((u) => [u.id, u.orgId])
      : [],
  );
  const origins = createOriginBook();
  await origins.prefetch(orgOf.values());

  const remindedByOrg = new Map<string, number>();
  const fallbackOrg = people.some((p) => !orgOf.get(p.id)) ? await defaultOrgId() : null;

  let reminded = 0;
  for (const p of people) {
    const leaveUrl = `${await origins.urlFor(orgOf.get(p.id))}/re-engage?token=${makeLeaveToken(p.id)}`;
    try {
      await sendEmail({
        to: p.email,
        orgId: orgOf.get(p.id) ?? null,
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
    const org = orgOf.get(p.id) ?? fallbackOrg!;
    remindedByOrg.set(org, (remindedByOrg.get(org) ?? 0) + 1);
  }

  await notifyOrgAdmins(remindedByOrg, (a, count) =>
    notify(a.id, 're_engagement.adminSummary', { count }, '/admin/candidates?view=pool'),
  );
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
      orgId: true,
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
        select: { id: true, orgId: true, email: true, fullName: true, emailNotifications: true, notificationPrefs: true },
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
    select: { id: true, orgId: true, fullName: true, targetPosition: true, skills: true },
  });
  if (pool.length === 0) return { companies: companies.length, alerts: 0 };
  // A company is matched against ITS OWN tenant's pool only: this cron binds no
  // tenant context, and an alert naming another tenant's (or world's) candidate
  // is a leak with a /p/<id> link attached. NULL is the default org either side.
  const defaultId = await defaultOrgId();
  const brandOf = createBrandBook();
  const capabilitiesOf = capabilitiesMemo();

  // WORLDS (#2590): the "view profile" link opens the product the COMPANY USER's
  // account lives in, resolved per user from their own organization. Read for
  // every company user up front, before the first dedupe row is inserted (an
  // inserted row is a candidate this company will never be alerted about again).
  const origins = createOriginBook();
  await origins.prefetch(companies.flatMap((company) => company.users.map((u) => u.orgId)));
  let alerts = 0;

  for (const company of companies) {
    // Matching the talent pool against open roles is placement work: an org
    // without the module (a MARKETING sales book) gets no alert at all —
    // skipped before any dedupe row is written, not re-branded.
    if (!(await capabilitiesOf(company.orgId)).includes('placements')) continue;
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
      if (!sameTenant(cand.orgId, company.orgId, defaultId)) continue;
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
          const base = await origins.urlFor(u.orgId);
          await brandOf(u.orgId).then((brand) => sendEmail({
            category: 'company-need-alert',
            userId: u.id,
            orgId: u.orgId,
            to: u.email,
            subject: 'A candidate matches your open position',
            html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              ${worldHeading(brand, 'New matching candidate', '<h2 style="color:#2563eb;">New matching candidate</h2>')}
              <p>Hi ${u.fullName},</p>
              <p><strong>${cand.fullName}</strong> matches one of ${company.name}'s open positions${cand.targetPosition ? ` (${cand.targetPosition})` : ''}.</p>
              <p><a href="${base}${link}">View profile</a></p>
            </div>`,
          })).catch((error) => {
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
  // WORLDS (#2590): each RECIPIENT's link opens the product their own account
  // lives in — the mentee and the mentors on their relations are resolved
  // separately from their own `orgId`, one batched read per page below.
  const origins = createOriginBook();
  const capabilitiesOf = capabilitiesMemo();
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
      // Before this page's claims, so a failed read leaves them unwritten.
      await origins.prefetch(
        mentees.flatMap((mentee) => [mentee.orgId, ...mentee.menteeRelations.map((relation) => relation.mentor.orgId)]),
      );

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
            // A MARKETING rep's record is /sales/leads/<id>, never the mentor
            // module their shell would bounce them out of (notificationLink).
            const link = isMentee
              ? '/portal/profile#documents'
              : notificationLink(
                  'MENTOR',
                  'relation',
                  { relationId: recipient.relationId ?? undefined },
                  { capabilities: await capabilitiesOf(org.id) },
                );
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
              const base = await origins.urlFor(recipient.orgId);
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
                  ${ctaBlock(brand, `${base}${link}`, t.reminderCta)}
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
// for an org whose premiumAnalytics setting is on (tenant row, then the global
// row: the settings rule). Sends each active admin a compact summary OF THEIR
// OWN ORG — total relations, conversion, stage counts and the last 7 days'
// activity — honoring the per-user digest email opt-out.
//
// Per org, never per installation: this cron binds no tenant context, and the
// counts used to add up every tenant of both worlds under an "Internship CRM"
// subject in every admin's mail (docs/worlds.md).
export async function sendWeeklyAnalyticsReport() {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN', isActive: true },
    select: { id: true, orgId: true, email: true, fullName: true, emailNotifications: true, notificationPrefs: true },
  });
  // A NULL-org admin is the default org's (tenantFilter's rule).
  const fallbackOrg = admins.some((a) => !a.orgId) ? await defaultOrgId() : null;
  const byOrg = new Map<string, typeof admins>();
  for (const a of admins) {
    const org = a.orgId ?? fallbackOrg!;
    byOrg.set(org, [...(byOrg.get(org) ?? []), a]);
  }
  // WORLDS (#2590): the dashboard link is resolved per ADMIN from that admin's
  // own organization.
  const origins = createOriginBook();
  await origins.prefetch(admins.map((a) => a.orgId));

  let locked = true;
  let sent = 0;
  for (const [orgId, orgAdmins] of byOrg) {
    if ((await getSetting('premiumAnalytics', orgId)) !== 'true') continue;
    locked = false;
    const tenant = await orgWhere(orgId);
    const [byStage, newRelations, interactions, outcome, brand] = await Promise.all([
      prisma.mentorshipRelation.groupBy({ by: ['pipelineStatus'], where: tenant, _count: { _all: true } }),
      prisma.mentorshipRelation.count({ where: { AND: [tenant, { startDate: { gte: weekAgo } }] } }),
      prisma.interactionLog.count({ where: { date: { gte: weekAgo }, relation: { is: tenant } } }),
      // The tenant's own finished stages (#1882), as /admin/analytics counts them.
      outcomeStageKeys(orgId),
      emailBrand(orgId),
    ]);
    const ownWorld = brand.vertical !== DEFAULT_VERTICAL;
    const stages = ownWorld ? await resolvePipelineStages(orgId) : null;

    const total = byStage.reduce((n, s) => n + s._count._all, 0);
    const finished = new Set(outcome.finished);
    const hired = byStage.filter((s) => finished.has(s.pipelineStatus)).reduce((n, s) => n + s._count._all, 0);
    const conversion = total ? Math.round((hired / total) * 100) : 0;
    const stageRows = byStage
      .sort((a, b) => b._count._all - a._count._all)
      .map((s) => `<tr><td style="padding:4px 12px 4px 0;">${stages ? esc(stageLabel(stages, s.pipelineStatus)) : s.pipelineStatus}</td><td style="padding:4px 0;"><strong>${s._count._all}</strong></td></tr>`) // eslint-disable-line
      .join('');
    // The default world keeps its report as it always read; another world's
    // admin gets its own product name and funnel words, not "mentorship" ones.
    const summary = ownWorld
      ? `<strong>${total}</strong> records · <strong>${conversion}%</strong> reached ${esc(outcome.finishedLabel || 'the final stage')} ·
        last 7 days: <strong>${newRelations}</strong> new records, <strong>${interactions}</strong> interactions.`
      : `<strong>${total}</strong> mentorship relations · <strong>${conversion}%</strong> hired conversion ·
        last 7 days: <strong>${newRelations}</strong> new relations, <strong>${interactions}</strong> interactions.`;

    for (const a of orgAdmins) {
      // 'analytics-report' is `reports_analytics`; the legacy 'digest' conjunct
      // that used to stand here belonged to `digests` and killed the report while
      // the preference surfaces showed it as ON. 'digest' is in
      // reports_analytics.legacy now, so the old opt-out still holds visibly.
      if (!emailGroupAllowedForCategory(a, 'analytics-report')) continue;
      const base = await origins.urlFor(a.orgId);
      await sendEmail({
        category: 'analytics-report',
        userId: a.id,
        orgId: a.orgId,
        to: a.email,
        subject: `Weekly analytics report — ${ownWorld ? brand.name : 'Internship CRM'}`,
        html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${worldHeading(brand, 'Weekly analytics report', '<h2 style="color:#2563eb;">Weekly analytics report</h2>')}
        <p>Hi ${a.fullName},</p>
        <p>${summary}</p>
        <table style="font-size:14px;border-collapse:collapse;">${stageRows}</table>
        <p><a href="${base}/admin/analytics">Open the analytics dashboard</a></p>
      </div>`,
      }).catch((error) => {
        console.error('sendWeeklyAnalyticsReport email failed:', { userId: a.id, error });
      });
      sent++;
    }
  }
  return { locked, sent };
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

  // #1720: `preferredLanguage` was not selected here either — the highest-volume
  // mail in the app went out in English to everyone. Both sides of a relation
  // are loaded through this select, and the digest is rendered once per
  // recipient, so each half reads its own language.
  const userSelect = { id: true, orgId: true, fullName: true, email: true, emailNotifications: true, notificationPrefs: true, preferredLanguage: true } as const;
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
      // In the recipient's language too — a deleted sender should not be the one
      // English word in an otherwise Turkish digest (#1720).
      from:
        sender?.fullName ??
        getDictionary(resolveLocale(recipient.preferredLanguage)).notifications.unreadDigestEmail.unknownSender,
      preview: m.body.slice(0, 120),
    });
    byRecipient.set(recipient.id, entry);
  }

  // WORLDS (#2590): the digest's message and mark-as-read links open the product
  // the RECIPIENT's account lives in, resolved per recipient from their own
  // `orgId`. Read for the whole batch before anything is marked digested.
  const origins = createOriginBook();
  await origins.prefetch([...byRecipient.values()].map((entry) => entry.recipient.orgId));
  const brandOf = createBrandBook();

  let sent = 0;
  for (const { recipient, items } of byRecipient.values()) {
    // The mail's taxonomy home is `digests`, and that is the only thing checked
    // here. The legacy 'messages' key existing opt-outs are recorded under maps
    // to direct_messages, so as a conjunct it suppressed a digest the surfaces
    // showed as ON; it is listed in digests.legacy instead.
    if (!emailGroupAllowedForCategory(recipient, 'unread-digest')) continue;
    // LOCALE (#1720): a message recipient is always a registered participant of
    // the relation, so their own stored preference is the only input.
    const rLocale = resolveLocale(recipient.preferredLanguage);
    const base = await origins.urlFor(recipient.orgId);
    const U = getDictionary(rLocale).notifications.unreadDigestEmail;
    const one = items.length === 1;
    const rows = items
      .map((it) => {
        const safe = it.preview.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));
        // Deliberately NO per-line reaction links here, unlike the live
        // notification. A five-item digest would carry 25 extra links, and a
        // high link count is one of the strongest spam signals there is —
        // exactly what this whole change set exists to avoid. The digest is a
        // "what did I miss" summary; reacting belongs on the message email.
        return `<li style="margin-bottom:8px;"><strong>${it.from}:</strong> ${safe || esc(U.attachment)} — <a href="${base}/messages/${it.relationId}">${esc(U.open)}</a></li>`;
      })
      .join('');
    // One link that clears the whole summary. Every item here belongs to the
    // same recipient, so marking each distinct thread read covers all of them.
    const relationIds = [...new Set(items.map((it) => it.relationId))];
    const markAllHtml = relationIds
      .map(
        (relationId, i) =>
          `<a href="${markReadUrl(relationId, recipient.id, base)}" style="color:#6b7280;">${esc(
            relationIds.length === 1 ? U.markOne : U.markNth.replace('{n}', String(i + 1)),
          )}</a>`,
      )
      .join(' · ');
    try {
      const brand = await brandOf(recipient.orgId);
      await sendEmail({
        to: recipient.email!,
        userId: recipient.id,
        orgId: recipient.orgId,
        category: 'unread-digest',
        locale: rLocale,
        // One and many are separate keys, not an appended "s": Turkish puts the
        // count before an uninflected noun and German inflects the noun itself.
        subject: one ? U.subjectOne : U.subjectMany.replace('{n}', String(items.length)),
        html: `<div style="font-family: Arial, sans-serif; max-width: 680px; margin: 0 auto;">
          ${worldHeading(brand, esc(U.heading), `<h2 style="color:#2563eb;">${esc(U.heading)}</h2>`)}
          <p>${esc(
            (one ? U.greetingOne : U.greetingMany.replace('{n}', String(items.length))).replace(
              '{name}',
              recipient.fullName,
            ),
          )}</p>
          <ul style="padding-left:18px;">${rows}</ul>
          <p style="font-size:13px;color:#6b7280;">${markAllHtml}</p>
          <p style="font-size:12px;color:#9ca3af;">${esc(U.footer)}</p>
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

/**
 * Prune the delivery ledger. Called by the daily retention job (#1678), which
 * registers it as the `emailLog` entry of the one retention registry — this is
 * no longer a line inside the 09:00 mail tick.
 *
 * Batched since #1678, and the reason is the first run rather than the steady
 * state: after a year of unpruned growth a single `DELETE ... WHERE createdAt <
 * ?` locks every matched row for the length of the statement, and every mail
 * being logged queues behind it. The steady state is a few hundred rows a day
 * either way.
 */
export async function pruneEmailLog(
  retentionDays: number = EMAIL_LOG_RETENTION_DAYS,
  opts: { batchSize?: number; budget?: number } = {}
) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const { processed, capped } = await pruneInBatches({
    batchSize: opts.batchSize,
    budget: opts.budget,
    selectIds: async (take) =>
      (
        await prisma.emailLog.findMany({
          where: { createdAt: { lt: cutoff } },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
          take,
        })
      ).map((r) => r.id),
    handleBatch: async (ids) => (await prisma.emailLog.deleteMany({ where: { id: { in: ids } } })).count,
  });
  return { deleted: processed, cutoff, capped };
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
      // The EmailLog prune used to be the last line of this tick. It moved to
      // the one retention job (#1678, `src/lib/retentionEntries.ts`, 03:20 UTC)
      // together with the four other tables that need a window — housekeeping
      // that happens to be about mail is still housekeeping, and the product
      // should have exactly one place where rows are deleted on a clock.
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
