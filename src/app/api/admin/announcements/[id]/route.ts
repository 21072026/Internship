import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { logActivity } from '@/lib/activity';
import { withTenantScope } from '@/lib/orgContext';
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

// Editing and deleting a published announcement (#1162). Until this existed a
// typo in a broadcast was permanent and a superseded one stayed on everyone's
// screen forever — POST was the only verb the resource had.
//
// An edit deliberately does NOT re-broadcast: no second notification, no second
// email. It corrects a record people have already been handed, so the copy in
// their bell is rewritten in place (that is what Notification.announcementId is
// for) rather than arriving again as if it were news.

const IMAGE_ERROR: Record<string, string> = {
  unsupported: 'Only PNG, JPEG, WebP or GIF images are allowed',
  tooLarge: `Image too large (max ${ANNOUNCEMENT_IMAGE_MAX_BYTES / (1024 * 1024)} MB)`,
  unreadable: CONTENT_MISMATCH_ERROR,
};

const schema = z.object({
  // Optional since #1163 — see the POST route: a body may arrive as `text`, as
  // `translations`, or both, and the canonical `text` is derived from whichever
  // is present.
  text: z.string().max(TEXT_LIMITS.announcementText).optional(),
  translations: z.record(z.string(), z.string()).optional(),
  link: z.string().max(TEXT_LIMITS.announcementLink).optional(),
  // 'keep' (default) leaves the attached image alone, 'remove' detaches it; a
  // new file on the multipart path replaces it.
  imageAction: z.enum(['keep', 'remove']).optional(),
});

/** A multipart field carrying JSON; an unparseable one is dropped, not thrown. */
function safeJson(value: FormDataEntryValue | null): unknown {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

// Same two body shapes POST accepts: JSON when there is no file, multipart when
// the admin swaps the image.
async function readBody(request: Request): Promise<{ fields: unknown; image: File | null }> {
  try {
    if (!(request.headers.get('content-type') || '').includes('multipart/form-data')) {
      return { fields: await request.json(), image: null };
    }
    const form = await request.formData();
    const image = form.get('image');
    return {
      fields: {
        ...(form.get('text') ? { text: form.get('text') } : {}),
        ...(form.get('translations') ? { translations: safeJson(form.get('translations')) } : {}),
        ...(form.get('link') ? { link: form.get('link') } : {}),
        ...(form.get('imageAction') ? { imageAction: form.get('imageAction') } : {}),
      },
      image: image instanceof File && image.size > 0 ? image : null,
    };
  } catch {
    return { fields: null, image: null };
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const { id } = await params;
    const existing = await prisma.announcement.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const { fields, image } = await readBody(request);
    const parsed = schema.safeParse(fields);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }
    const { link, imageAction } = parsed.data;
    const translations = normalizeAnnouncementTranslations(parsed.data.translations);
    const text = canonicalAnnouncementText(translations, parsed.data.text);
    if (!text) {
      return NextResponse.json({ error: 'Validation failed', details: { formErrors: ['text required'] } }, { status: 400 });
    }

    // Validated before anything is written, exactly as on POST: a rejected image
    // must not leave the text half-updated.
    let imageData: Buffer | null = null;
    if (image) {
      const invalid = await validateAnnouncementImage(image);
      if (invalid) return NextResponse.json({ error: IMAGE_ERROR[invalid] }, { status: 400 });
      imageData = Buffer.from(await image.arrayBuffer());
    }

    await prisma.announcement.update({
      where: { id },
      data: {
        text,
        translations,
        link: link || null,
        ...(imageData && image
          ? {
              // upsert, not create: replacing an existing image would otherwise
              // violate AnnouncementImage's unique announcementId.
              image: {
                upsert: {
                  create: { contentType: image.type, size: image.size, data: imageData },
                  update: { contentType: image.type, size: image.size, data: imageData },
                },
              },
            }
          : imageAction === 'remove'
            ? { image: { delete: true } }
            : {}),
      },
    });

    // Rewrite the copy already delivered to everyone's bell, so the notification
    // and the announcement can never disagree.
    //
    // Each row holds the body in ITS OWN reader's language (#1163), so this is
    // one statement per distinct resolved body — at most three — rather than a
    // single blanket overwrite, which would flatten every recipient back to the
    // canonical wording and undo the translation for two thirds of them.
    const delivered = await prisma.notification.findMany({
      where: { announcementId: id },
      select: { id: true, user: { select: { preferredLanguage: true } } },
    });
    const byBody = new Map<string, string[]>();
    for (const row of delivered) {
      const body = resolveAnnouncementText({ text, translations }, row.user.preferredLanguage);
      byBody.set(body, [...(byBody.get(body) ?? []), row.id]);
    }
    for (const [body, ids] of byBody) {
      await prisma.notification.updateMany({
        where: { id: { in: ids } },
        data: { text: body, link: link || null },
      });
    }

    const withImage = await prisma.announcement.findUnique({
      where: { id },
      select: { image: { select: { id: true } } },
    });

    await logActivity({
      action: 'announcement.update',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
    });
    return NextResponse.json({ id, imageUrl: withImage?.image ? announcementImageUrl(id) : null });
  });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const { id } = await params;
    const existing = await prisma.announcement.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // The bell rows go first: a notification whose announcement no longer exists
    // is a dead link on every user's screen. AnnouncementImage follows the
    // announcement on its own (onDelete: Cascade).
    const { count } = await prisma.notification.deleteMany({ where: { announcementId: id } });
    await prisma.announcement.delete({ where: { id } });

    await logActivity({
      action: 'announcement.delete',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
    });
    return NextResponse.json({ deleted: true, notificationsRemoved: count });
  });
}
