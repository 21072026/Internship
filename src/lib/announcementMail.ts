import type { Prisma } from '@prisma/client';
import { brandHeader, emailBrand, sendEmail } from '@/services/emailService';
import { logger } from '@/lib/logger';
import { DEFAULT_VERTICAL } from '@/lib/verticals';
import { defaultLocale, isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/dictionaries';
import { resolveAnnouncementText } from '@/lib/announcementText';
import { fanOutWidth, mailPolicy } from '@/lib/mailWorkerRule';
import { mapWithConcurrency } from '@/lib/bulkInvite';

// The e-mail half of an announcement broadcast (#2951): one mail per recipient,
// handed to `sendEmail()` with a bounded width (`fanOutWidth`).
//
// It used to be a single unbounded `Promise.all` over every recipient — the
// largest burst the product made: N simultaneous SMTP conversations, and the
// relay's per-minute limit lost the tail of it. With BULK on the mail queue
// (`MAIL_QUEUE_LANES`) each call is one enqueue that returns in milliseconds,
// one at a time, and the drain paces the relay; with BULK still inline, four in
// flight — never N, and not one either, which would hold the admin's request
// four times as long (and invite a resend that broadcasts twice).
//
// Split out of `POST /api/admin/announcements` so the fan-out is one function
// the route and the e2e spec both call — the spec drives it against a fake SMTP
// server in its own process (the app server Playwright boots sends no mail).

/** Content-ID the announcement mail's <img> references. */
export const ANNOUNCEMENT_IMAGE_CID = 'announcement-image';

// Derived from the (already allow-listed) MIME type rather than taken from the
// upload: an attacker-supplied filename has no business landing in a mail header.
export function announcementEmailImageFilename(contentType: string): string {
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[contentType] ?? 'img';
  return `announcement.${ext}`;
}

export interface AnnouncementMailRecipient {
  id: string;
  email: string;
  orgId: string | null;
  emailNotifications: boolean | null;
  notificationPrefs: Prisma.JsonValue;
  preferredLanguage: string | null;
}

export interface AnnouncementMailInput {
  /** Who is mailed — already filtered by the caller (and metered by it). */
  recipients: AnnouncementMailRecipient[];
  /** The canonical body and its translations (#1163). */
  text: string;
  translations: Record<string, string> | Prisma.JsonValue;
  link?: string | null;
  image?: { data: Buffer; contentType: string } | null;
}

export interface AnnouncementMailResult {
  /** Handed to the relay or put on the mail queue — everything but SKIPPED. */
  emailed: number;
  /** Of `emailed`, the ones waiting on the mail queue. */
  queued: number;
  /** Mails that failed for good (a 5xx, or no queue to fall back on). */
  failed: number;
}

const escapeHtml = (value: string) =>
  value.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] as string);

export async function mailAnnouncement(input: AnnouncementMailInput): Promise<AnnouncementMailResult> {
  const { recipients, text, link, image } = input;
  const translations = input.translations as Parameters<typeof resolveAnnouncementText>[0]['translations'];
  const result: AnnouncementMailResult = { emailed: 0, queued: 0, failed: 0 };

  // The image is attached inline (cid:) rather than linked: /api/announcements/
  // <id>/image requires a session, so an <img src="https://…"> would render as
  // a broken image in every mail client.
  const imageHtml = image ? `<p><img src="cid:${ANNOUNCEMENT_IMAGE_CID}" alt="" style="max-width:100%;height:auto"></p>` : '';
  const attachments = image
    ? [{ filename: announcementEmailImageFilename(image.contentType), content: image.data, contentType: image.contentType, cid: ANNOUNCEMENT_IMAGE_CID }]
    : undefined;
  // A reader outside the default world gets their own org's header — logo,
  // accent — so a marketing broadcast does not look like an internship one
  // (docs/worlds.md); the default world keeps the bare heading it always had.
  // The sender name is sendEmail's job (it has `orgId`). The audience is one
  // tenant, so this is one lookup.
  const brands = new Map<string, ReturnType<typeof emailBrand>>();
  const brandOf = (orgId: string | null) => {
    const key = orgId ?? '';
    let hit = brands.get(key);
    if (!hit) brands.set(key, (hit = emailBrand(orgId)));
    return hit;
  };

  await mapWithConcurrency(recipients, fanOutWidth(mailPolicy(process.env), 'BULK'), async (u) => {
    const preferredLanguage = u.preferredLanguage ?? undefined;
    const locale = isLocale(preferredLanguage) ? preferredLanguage : defaultLocale;
    const t = getDictionary(locale);
    // The body follows the recipient's language too, not just the shell around
    // it — before #1163 only the subject and the link label were translated
    // while the message itself went out in one language.
    const safe = escapeHtml(resolveAnnouncementText({ text, translations }, u.preferredLanguage));
    const bodyHtml = `<p>${safe.replace(/\n/g, '<br>')}</p>${imageHtml}${link ? `<p><a href="${link}">${t.announcements.emailOpenLink}</a></p>` : ''}`;
    try {
      // Inside the per-recipient try, so a failed brand read is one logged
      // failure like a failed send, not a rejected broadcast.
      const brand = await brandOf(u.orgId);
      const delivery = await sendEmail({
        to: u.email,
        category: 'announcement',
        subject: t.announcements.emailSubject,
        html: `${
          brand.vertical === DEFAULT_VERTICAL ? `<h2>${t.announcements.emailSubject}</h2>` : brandHeader(brand, t.announcements.emailSubject)
        }${bodyHtml}`,
        attachments,
        // One mail per recipient in the broadcast, each with its own
        // unsubscribe token — this is the highest-volume mail the product sends
        // and the one people most want a working opt-out for. The footer takes
        // the same language the body was just rendered in.
        userId: u.id,
        locale: u.preferredLanguage,
        // The preference columns the caller already selected for all of them,
        // handed to the central check so it does not re-read the same two
        // values once per recipient. Data, not a bypass: `sendEmail` still runs
        // the same check on it, and the caller's filter uses the very same row,
        // so the two cannot disagree about what this person chose.
        prefs: u,
        // Handed over with `prefs`, which skips the read that would have learned it.
        orgId: u.orgId,
      });
      if (delivery !== 'SKIPPED') result.emailed++;
      if (delivery === 'QUEUED') result.queued++;
    } catch (e) {
      result.failed++;
      logger.error('Failed to send announcement email', { error: e instanceof Error ? e.name : 'unknown' });
    }
  });
  return result;
}
