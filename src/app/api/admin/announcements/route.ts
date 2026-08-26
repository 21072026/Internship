import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { logActivity } from '@/lib/activity';
import { sendEmail } from '@/services/emailService';
import { logger } from '@/lib/logger';
import { emailAllowed } from '@/lib/notificationPrefs';
import { emailGroupAllowedForCategory } from '@/lib/emailGroups';
import { withTenantScope } from '@/lib/orgContext';
import { defaultLocale, isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/dictionaries';
import {
  validateAnnouncementImage,
  announcementImageUrl,
  ANNOUNCEMENT_IMAGE_MAX_BYTES,
  CONTENT_MISMATCH_ERROR,
} from '@/lib/announcementImage';
import {
  normalizeAnnouncementTranslations,
  canonicalAnnouncementText,
  resolveAnnouncementText,
} from '@/lib/announcementText';

const schema = z.object({
  // Long-form announcements (release notes, articles) are allowed; the previous
  // 2 000-char cap rejected them with a bare 400. Kept bounded to protect the
  // per-user notification fan-out.
  //
  // Optional since #1163: an admin may send `translations` instead, in which
  // case `text` is derived from them. One of the two must produce a body — see
  // the empty check in the handler.
  text: z.string().max(TEXT_LIMITS.announcementText).optional(),
  // { en?, tr?, de? }. Unknown keys and blank values are dropped by
  // normalizeAnnouncementTranslations rather than rejected, so a form that
  // submits three boxes with two of them empty is valid.
  translations: z.record(z.string(), z.string()).optional(),
  link: z.string().max(TEXT_LIMITS.announcementLink).optional(),
  email: z.boolean().optional(),
});

// Content-ID the announcement email's <img> references.
const IMAGE_CID = 'announcement-image';

// Derived from the (already allow-listed) MIME type rather than taken from the
// upload: an attacker-supplied filename has no business landing in a mail header.
function emailImageFilename(contentType: string) {
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[contentType] ?? 'img';
  return `announcement.${ext}`;
}

const IMAGE_ERROR: Record<string, string> = {
  unsupported: 'Only PNG, JPEG, WebP or GIF images are allowed',
  tooLarge: `Image too large (max ${ANNOUNCEMENT_IMAGE_MAX_BYTES / (1024 * 1024)} MB)`,
  // Same wording as every other upload route (#888).
  unreadable: CONTENT_MISMATCH_ERROR,
};

/** A multipart field carrying JSON; an unparseable one is dropped, not thrown. */
function safeJson(value: FormDataEntryValue | null): unknown {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * The body arrives either as JSON (no image — the original contract, still used
 * by API clients and several e2e specs) or as multipart/form-data when the admin
 * attaches an image. Normalised here so the handler below sees one shape.
 */
async function readBody(request: Request): Promise<{ fields: unknown; image: File | null }> {
  try {
    if (!(request.headers.get('content-type') || '').includes('multipart/form-data')) {
      return { fields: await request.json(), image: null };
    }
    const form = await request.formData();
    const image = form.get('image');
    return {
      fields: {
        // FormData has no undefined: an omitted optional field reads as null, which
        // `.optional()` rejects — drop the empty ones instead.
        ...(form.get('text') ? { text: form.get('text') } : {}),
        // The multilingual form sends one field per language; JSON clients send
        // a `translations` object. Both land in the same shape here.
        ...(form.get('translations') ? { translations: safeJson(form.get('translations')) } : {}),
        ...(form.get('link') ? { link: form.get('link') } : {}),
        ...(form.get('email') === null ? {} : { email: form.get('email') === 'true' }),
      },
      image: image instanceof File && image.size > 0 ? image : null,
    };
  } catch {
    // An unparseable body should be the 400 below, not an unhandled 500.
    return { fields: null, image: null };
  }
}

// GET — paginated history of past broadcasts (most recent first).
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
  const pageSize = 20;

  const [total, announcements] = await Promise.all([
    prisma.announcement.count(),
    prisma.announcement.findMany({
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      // `select: { id: true }` on the relation, never the blob — an `include`
      // would drag every attached image's bytes into the history response.
      include: { image: { select: { id: true } } },
    }),
  ]);

  const senderIds = [...new Set(announcements.map((a) => a.sentById))];
  const senders = await prisma.user.findMany({ where: { id: { in: senderIds } }, select: { id: true, fullName: true } });
  const senderName = new Map(senders.map((s) => [s.id, s.fullName]));

  return NextResponse.json({
    announcements: announcements.map(({ image, ...a }) => ({
      ...a,
      // Normalized rather than passed through raw: the edit form binds one box
      // per language and should never be handed an unexpected key (#1163).
      translations: normalizeAnnouncementTranslations(a.translations),
      sentByName: senderName.get(a.sentById) ?? null,
      imageUrl: image ? announcementImageUrl(a.id) : null,
    })),
    total,
    page,
    pageSize,
  });
  });
}

// POST — broadcast an announcement to every active user as an in-app
// notification, optionally also by email (respecting each user's opt-out).
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
  const { fields, image } = await readBody(request);
  const parsed = schema.safeParse(fields);
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  const { link, email } = parsed.data;

  // One message, up to three languages (#1163). `text` is the canonical body —
  // the default locale's version, or the first language that was filled in —
  // and it is what a reader whose language was never written falls back to.
  const translations = normalizeAnnouncementTranslations(parsed.data.translations);
  const text = canonicalAnnouncementText(translations, parsed.data.text);
  // Neither a `text` nor a single non-blank translation: there is no message.
  if (!text) {
    return NextResponse.json({ error: 'Validation failed', details: { formErrors: ['text required'] } }, { status: 400 });
  }

  // Validated (type, size, magic bytes) before any fan-out happens — a rejected
  // image must not leave behind notifications for a broadcast that never landed.
  let imageData: Buffer | null = null;
  if (image) {
    const invalid = await validateAnnouncementImage(image);
    if (invalid) return NextResponse.json({ error: IMAGE_ERROR[invalid] }, { status: 400 });
    imageData = Buffer.from(await image.arrayBuffer());
  }

  const users = await prisma.user.findMany({
    where: { isActive: true },
    select: { id: true, email: true, emailNotifications: true, notificationPrefs: true, preferredLanguage: true },
  });

  // The Announcement row is written BEFORE the fan-out, so every notification it
  // produces can carry its id (#1162) — that link is what lets a later edit
  // correct the copy already sitting in everyone's bell, and a delete take those
  // rows with it. `emailedCount` is the one thing not knowable yet; it is filled
  // in once the sending below settles.
  const announcement = await prisma.announcement.create({
    data: {
      text,
      translations,
      link: link || null,
      sentById: session.user.id,
      recipientCount: users.length,
      ...(imageData && image
        ? { image: { create: { contentType: image.type, size: image.size, data: imageData } } }
        : {}),
    },
  });

  // Bulk-create the in-app notifications in one statement. Each row carries the
  // body in ITS OWN reader's language: a notification is a per-user record, so
  // resolving once per recipient here is both cheaper and more honest than
  // storing one language and re-resolving at read time.
  await prisma.notification.createMany({
    data: users.map((u) => ({
      userId: u.id,
      type: 'announcement',
      text: resolveAnnouncementText({ text, translations }, u.preferredLanguage),
      link: link || null,
      announcementId: announcement.id,
    })),
  });

  let emailed = 0;
  if (email) {
    const escapeHtml = (value: string) =>
      value.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));
    // The image is attached inline (cid:) rather than linked: /api/announcements/
    // <id>/image requires a session, so an <img src="https://…"> would render as
    // a broken image in every mail client.
    const imageHtml = imageData ? `<p><img src="cid:${IMAGE_CID}" alt="" style="max-width:100%;height:auto"></p>` : '';
    const attachments = imageData && image
      ? [{ filename: emailImageFilename(image.type), content: imageData, contentType: image.type, cid: IMAGE_CID }]
      : undefined;
    await Promise.all(
      users
        // Both conjuncts: the group check is what makes `emailed` truthful once
        // people can unsubscribe from announcements. Without it the counter
        // would keep counting mails that sendEmail() then declines to deliver.
        .filter((u) => u.email && emailAllowed(u, 'announcements') && emailGroupAllowedForCategory(u, 'announcement'))
        .map((u) => {
          const preferredLanguage = u.preferredLanguage ?? undefined;
          const locale = isLocale(preferredLanguage) ? preferredLanguage : defaultLocale;
          const t = getDictionary(locale);
          // The body follows the recipient's language too, not just the shell
          // around it — before #1163 only the subject and the link label were
          // translated while the message itself went out in one language.
          const safe = escapeHtml(resolveAnnouncementText({ text, translations }, u.preferredLanguage));
          const html = `<h2>${t.announcements.emailSubject}</h2><p>${safe.replace(/\n/g, '<br>')}</p>${imageHtml}${link ? `<p><a href="${link}">${t.announcements.emailOpenLink}</a></p>` : ''}`;
          return sendEmail({
            to: u.email,
            category: 'announcement',
            subject: t.announcements.emailSubject,
            html,
            attachments,
            // One mail per recipient in the broadcast, each with its own
            // unsubscribe token — this is the highest-volume mail the product
            // sends and the one people most want a working opt-out for. The
            // footer takes the same language the body was just rendered in.
            userId: u.id,
            locale: u.preferredLanguage,
          }).then(
            () => { emailed++; },
            (e) => logger.error('Failed to send announcement email', { error: String(e) })
          );
        })
    );
  }

  if (emailed > 0) {
    await prisma.announcement.update({ where: { id: announcement.id }, data: { emailedCount: emailed } });
  }

  await logActivity({ action: 'announcement.broadcast', actorId: session.user.id, actorEmail: session.user.email ?? null });
  return NextResponse.json(
    { recipients: users.length, emailed, imageUrl: imageData ? announcementImageUrl(announcement.id) : null },
    { status: 201 }
  );
  });
}
