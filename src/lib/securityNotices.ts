/**
 * Security notices (#1717) — the ONE sender behind "something changed on your
 * account" mail: a sign-in from a browser the account has not used before, a
 * replayed "keep me signed in" cookie, a password or e-mail change, 2FA turned
 * on or off, recovery codes replaced, every device signed out.
 *
 * WHY ONE MODULE. Each of these is a disclosure, not a notification: the
 * person it goes to may be the victim rather than the actor, so it ignores
 * every preference, quiet hour and opt-out — exactly what the `account_security`
 * e-mail group (src/lib/emailGroups.ts, essential) already guarantees for
 * `sendEmail()`. Every call site passes through here so that guarantee, the
 * recipient's locale and time zone, the device/IP context and the "not you?"
 * line cannot drift between nine routes.
 *
 * TWO CHANNELS, ONE CALL. The in-app row goes through notifyEvent() with the
 * channel pinned to `inApp`. The router's e-mail channel (#1719) renders the
 * event's template; a notice's mail needs the device, the time in the
 * reader's zone and the "not you?" block, so it is still sent inline here.
 *
 * WHAT A NOTICE NEVER CARRIES: a token, a hash, a password, a recovery code,
 * the raw user-agent (only the label deviceLabel() composes from it), or a
 * geolocation (the IP is quoted as-is so the reader can recognise their own
 * network; nothing is looked up). Never throws — a failed notice must not fail
 * the action that earned it.
 */
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { notifyEvent } from '@/lib/notifications/router';
import { clientIp, type HeaderSource } from '@/lib/clientIp';
import { deviceLabel } from '@/lib/deviceLabel';
import { formatDateTimeWithZone } from '@/lib/relativeTime';
import { getDictionary } from '@/i18n/dictionaries';
import { defaultLocale, isLocale, type Locale } from '@/i18n/config';
import { noteSignInDevice } from '@/lib/signInDevice';
import { newDeviceNoticeDue } from '@/lib/signInDeviceRule';

export const SECURITY_NOTICE_KINDS = [
  'newDevice',
  'deviceTokenReuse',
  'passwordChanged',
  'emailChanged',
  'twoFactorEnabled',
  'twoFactorDisabled',
  'recoveryCodesRegenerated',
  'sessionsRevoked',
  'adminSignedOutAll',
  // An affiliate partner's IBAN/holder changed (src/lib/affiliatePayoutDetails.ts).
  'payoutDetailsChanged',
] as const;
export type SecurityNoticeKind = (typeof SECURITY_NOTICE_KINDS)[number];

/** The EmailLog category every notice is recorded under (essential group `account_security`). */
export const SECURITY_NOTICE_CATEGORY = 'security';

export interface SecurityNoticeInput {
  /** The account the notice is about — and, except for `emailChanged`, its only recipient. */
  userId: string;
  /** The request that carried the action, for the browser and IP lines. */
  request?: HeaderSource | null;
  /** A device label to quote instead of the request's (the revoked TrustedDevice's, say). */
  device?: string | null;
  /** An address to quote instead of the request's. */
  ip?: string | null;
  /** `emailChanged` only: both addresses get the mail. */
  emailChange?: { from: string; to: string };
  now?: Date;
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

function localeOf(preferred?: string | null): Locale {
  return preferred && isLocale(preferred) ? preferred : defaultLocale;
}

/**
 * Tell the account owner. In-app first (cheap, local), then the mail. Resolves
 * once both were attempted; rejects never.
 */
export async function sendSecurityNotice(kind: SecurityNoticeKind, input: SecurityNoticeInput): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true, email: true, fullName: true, preferredLanguage: true, timezone: true, orgId: true },
    });
    if (!user) return;

    const now = input.now ?? new Date();
    const locale = localeOf(user.preferredLanguage);
    const M = getDictionary(locale).securityNoticeEmail;
    // Browser and address come from the request that carried the action, so an
    // admin-side notice (no request) quotes neither: the administrator's browser
    // is not the owner's, and a wrong "Browser:" line would be worse than none.
    const userAgent = input.request?.headers.get('user-agent') ?? null;
    const label = input.device ?? (input.request ? deviceLabel(userAgent) ?? M.unknownDevice : null);
    const device = label ?? M.unknownDevice;
    const ip = input.ip ?? (input.request ? clientIp(input.request) : null);
    const change = input.emailChange;

    // The in-app row. Only the declared placeholders are stored (router.ts).
    const eventKey = `security.${kind}` as const;
    await notifyEvent(
      { id: user.id, orgId: user.orgId },
      eventKey,
      { device, email: change?.to ?? user.email } as never,
      { channels: ['inApp'], orgId: user.orgId }
    );

    // Loaded here rather than imported: emailService imports half the server
    // (trustedDevice among it), and this module is imported from lib/auth.ts.
    // A static edge would close a cycle; the dynamic one keeps the graph one-way.
    const { sendEmail, emailBrand, brandHeader, esc, ctaBlock } = await import('@/services/emailService');
    const brand = await emailBrand(user.orgId);
    const K = M[kind];
    const vars = { device, from: change?.from ?? '', to: change?.to ?? '' };
    const when = formatDateTimeWithZone(now, locale, user.timezone);
    const context = [
      fill(M.when, { when }),
      ...(label ? [fill(M.device, { device: label })] : []),
      ...(ip && ip !== 'unknown' ? [fill(M.ip, { ip })] : []),
    ];
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${brandHeader(brand, esc(fill(K.heading, vars)))}
        ${user.fullName ? `<p>${esc(fill(M.greeting, { name: user.fullName }))}</p>` : ''}
        <p>${esc(fill(K.body, vars))}</p>
        <p style="color: #374151; font-size: 14px;">${context.map(esc).join('<br>')}</p>
        ${ctaBlock(brand, `${brand.appUrl}/account`, esc(M.cta))}
        <p style="color: #6b7280; font-size: 14px;">${esc(M.notYou)}</p>
      </div>
    `;
    const recipients = change ? [change.to, change.from] : [user.email];
    for (const to of recipients) {
      await sendEmail({
        to,
        fromName: brand.name,
        category: SECURITY_NOTICE_CATEGORY,
        userId: user.id,
        orgId: user.orgId,
        locale,
        subject: fill(K.subject, vars),
        html,
      });
    }
  } catch (e) {
    logger.error('security notice failed', { kind, userId: input.userId, error: String(e) });
  }
}

/**
 * The non-blocking variant for a sign-in path: the person is waiting for a
 * session, not for SMTP. The promise is detached and already cannot reject.
 */
export function fireSecurityNotice(kind: SecurityNoticeKind, input: SecurityNoticeInput): void {
  void sendSecurityNotice(kind, input);
}

/**
 * Called from a successful password or magic-link sign-in: remember the
 * browser, and notify when it is one the account has not used before (rule in
 * signInDeviceRule.ts). The row is written before this returns — the next
 * sign-in from the same browser must find it — and the mail is detached.
 */
export async function observeSignInDevice(userId: string, request: HeaderSource): Promise<void> {
  try {
    const noted = await noteSignInDevice(userId, request);
    if (newDeviceNoticeDue(noted)) {
      fireSecurityNotice('newDevice', { userId, request, device: noted.label, ip: noted.ip });
    }
  } catch (e) {
    logger.error('sign-in device note failed', { userId, error: String(e) });
  }
}
