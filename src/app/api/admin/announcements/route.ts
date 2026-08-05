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
import { withTenantScope } from '@/lib/orgContext';
import { defaultLocale, isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/dictionaries';
import {
  validateAnnouncementImage,
  announcementImageUrl,
  ANNOUNCEMENT_IMAGE_MAX_BYTES,
  CONTENT_MISMATCH_ERROR,
} from '@/lib/announcementImage';

const schema = z.object({
  // Long-form announcements (release notes, articles) are allowed; the previous
  // 2 000-char cap rejected them with a bare 400. Kept bounded to protect the
  // per-user notification fan-out.
  text: z.string().min(1).max(TEXT_LIMITS.announcementText),
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
        text: form.get('text'),
        // FormData has no undefined: an omitted optional field reads as null, which
        // `.optional()` rejects — drop the empty ones instead.
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
  const { text, link, email } = parsed.data;

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

  // Bulk-create the in-app notifications in one statement.
  await prisma.notification.createMany({
    data: users.map((u) => ({ userId: u.id, type: 'announcement', text, link: link || null })),
  });

  let emailed = 0;
  if (email) {
    const safe = text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));
    // The image is attached inline (cid:) rather than linked: /api/announcements/
    // <id>/image requires a session, so an <img src="https://…"> would render as
    // a broken image in every mail client.
    const imageHtml = imageData ? `<p><img src="cid:${IMAGE_CID}" alt="" style="max-width:100%;height:auto"></p>` : '';
    const attachments = imageData && image
      ? [{ filename: emailImageFilename(image.type), content: imageData, contentType: image.type, cid: IMAGE_CID }]
      : undefined;
    await Promise.all(
      users
        .filter((u) => u.email && emailAllowed(u, 'announcements'))
        .map((u) => {
          const preferredLanguage = u.preferredLanguage ?? undefined;
          const locale = isLocale(preferredLanguage) ? preferredLanguage : defaultLocale;
          const t = getDictionary(locale);
          const html = `<h2>${t.announcements.emailSubject}</h2><p>${safe.replace(/\n/g, '<br>')}</p>${imageHtml}${link ? `<p><a href="${link}">${t.announcements.emailOpenLink}</a></p>` : ''}`;
          return sendEmail({ to: u.email, subject: t.announcements.emailSubject, html, attachments }).then(
            () => { emailed++; },
            (e) => logger.error('Failed to send announcement email', { error: String(e) })
          );
        })
    );
  }

  const announcement = await prisma.announcement.create({
    data: {
      text,
      link: link || null,
      sentById: session.user.id,
      recipientCount: users.length,
      emailedCount: emailed,
      ...(imageData && image
        ? { image: { create: { contentType: image.type, size: image.size, data: imageData } } }
        : {}),
    },
  });

  await logActivity({ action: 'announcement.broadcast', actorId: session.user.id, actorEmail: session.user.email ?? null });
  return NextResponse.json(
    { recipients: users.length, emailed, imageUrl: imageData ? announcementImageUrl(announcement.id) : null },
    { status: 201 }
  );
  });
}
