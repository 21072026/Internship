import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import {
  validateAnnouncementImage,
  ANNOUNCEMENT_IMAGE_MAX_BYTES,
  CONTENT_MISMATCH_ERROR,
} from '@/lib/announcementImage';
import {
  canonicalNewsletterContent,
  newsletterImageUrl,
  normalizeNewsletterContent,
  writtenNewsletterLocales,
} from '@/lib/newsletter';
import { dispatchNewsletter } from '@/lib/newsletterDispatch';

/**
 * Newsletter issues: the history, and creating one (#1469).
 *
 * The image rules are deliberately the SAME objects the announcement composer
 * uses (`announcementImage.ts`) rather than a second copy — identical
 * constraints (a blob in our own DB, served from our own origin, no SVG because
 * an SVG can carry script) and a copy would only drift.
 */

const contentSchema = z.record(z.string(), z.unknown());

const schema = z.object({
  templateKey: z.string().max(64).optional(),
  audience: z.enum(['MENTEE', 'MENTOR', 'BOTH']).default('MENTEE'),
  // Per-locale bodies. Unknown keys and incomplete languages are dropped by
  // normalizeNewsletterContent rather than rejected, so a composer with three
  // tabs and one filled in is valid.
  content: contentSchema,
  // ISO 8601. Required for 'schedule', ignored otherwise.
  scheduledAt: z.string().datetime().optional(),
  // 'draft' saves it, 'schedule' hands it to the dispatcher, 'send' dispatches
  // it in this request. Three verbs rather than a status field: the caller says
  // what it wants to happen, the route owns which status that is.
  action: z.enum(['draft', 'schedule', 'send']).default('draft'),
});

const IMAGE_ERROR: Record<string, string> = {
  unsupported: 'Only PNG, JPEG, WebP or GIF images are allowed',
  tooLarge: `Image too large (max ${ANNOUNCEMENT_IMAGE_MAX_BYTES / (1024 * 1024)} MB)`,
  unreadable: CONTENT_MISMATCH_ERROR,
};

function safeJson(value: FormDataEntryValue | null): unknown {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * JSON when there is no image, multipart when there is — normalised here so the
 * handler sees one shape. Same arrangement as the announcement composer.
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
        ...(form.get('templateKey') ? { templateKey: form.get('templateKey') } : {}),
        ...(form.get('audience') ? { audience: form.get('audience') } : {}),
        ...(form.get('content') ? { content: safeJson(form.get('content')) } : {}),
        ...(form.get('scheduledAt') ? { scheduledAt: form.get('scheduledAt') } : {}),
        ...(form.get('action') ? { action: form.get('action') } : {}),
      },
      image: image instanceof File && image.size > 0 ? image : null,
    };
  } catch {
    return { fields: null, image: null };
  }
}

// GET — the sending history, newest first. This is the record the module exists
// to keep, so nothing is ever filtered out of it: drafts, canceled issues and
// sent ones all appear, with their per-recipient tallies.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
  const pageSize = 20;

  const [total, issues] = await Promise.all([
    prisma.newsletter.count(),
    prisma.newsletter.findMany({
      // Newest activity first, whichever kind it was: a draft touched today
      // belongs above an issue sent last month.
      orderBy: [{ createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        templateKey: true,
        audience: true,
        status: true,
        subject: true,
        content: true,
        scheduledAt: true,
        sentAt: true,
        createdById: true,
        recipientCount: true,
        sentCount: true,
        failedCount: true,
        skippedCount: true,
        createdAt: true,
        // `select` on the relation, never `include` — an include would drag
        // every hero image's bytes into the history response.
        image: { select: { id: true } },
      },
    }),
  ]);

  const authorIds = [...new Set(issues.map((i) => i.createdById))];
  const authors = await prisma.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, fullName: true } });
  const authorName = new Map(authors.map((a) => [a.id, a.fullName]));

  return NextResponse.json({
    newsletters: issues.map(({ image, content, ...issue }) => {
      const variants = normalizeNewsletterContent(content);
      return {
        ...issue,
        // Normalised rather than raw: the edit form binds one tab per language
        // and should never be handed an unexpected key.
        content: variants,
        languages: writtenNewsletterLocales(variants),
        createdByName: authorName.get(issue.createdById) ?? null,
        // 'system' is the sentinel the auto-schedule writes: there is no user
        // row behind it, and "queued by the schedule" is more useful to show
        // than a blank author.
        createdBySystem: issue.createdById === 'system',
        imageUrl: image ? newsletterImageUrl(issue.id) : null,
      };
    }),
    total,
    page,
    pageSize,
  });
}

// POST — create an issue as a draft, schedule it, or send it now.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { fields, image } = await readBody(request);
  const parsed = schema.safeParse(fields);
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  const { templateKey, audience, action } = parsed.data;

  const content = normalizeNewsletterContent(parsed.data.content);
  const canonical = canonicalNewsletterContent(content);
  // Not one complete language: subject, intro and at least one tip are what
  // make an issue sendable, and an e-mail missing any of them is a broken
  // e-mail rather than a short one.
  if (!canonical) {
    return NextResponse.json(
      { error: 'Validation failed', details: { formErrors: ['At least one language needs a subject, an intro and one tip'] } },
      { status: 400 }
    );
  }

  // A scheduled issue needs a time; "schedule for nothing" would sit as a
  // SCHEDULED row the dispatcher never picks up.
  let scheduledAt: Date | null = null;
  if (action === 'schedule') {
    if (!parsed.data.scheduledAt) {
      return NextResponse.json({ error: 'Validation failed', details: { formErrors: ['scheduledAt is required to schedule'] } }, { status: 400 });
    }
    scheduledAt = new Date(parsed.data.scheduledAt);
  } else if (action === 'send') {
    // Due immediately; the dispatch below runs in this request, and the cron is
    // the safety net if it does not finish.
    scheduledAt = new Date();
  }

  // Validated before the row is written — a rejected image must not leave
  // behind an issue that was never really created.
  let imageData: Buffer | null = null;
  if (image) {
    const invalid = await validateAnnouncementImage(image);
    if (invalid) return NextResponse.json({ error: IMAGE_ERROR[invalid] }, { status: 400 });
    imageData = Buffer.from(await image.arrayBuffer());
  }

  const created = await prisma.newsletter.create({
    data: {
      templateKey: templateKey || null,
      audience,
      status: action === 'draft' ? 'DRAFT' : 'SCHEDULED',
      subject: canonical.subject,
      content: content as unknown as Prisma.InputJsonValue,
      scheduledAt,
      createdById: session.user.id,
      ...(imageData && image
        ? { image: { create: { contentType: image.type, size: image.size, data: imageData } } }
        : {}),
    },
    select: { id: true, status: true, scheduledAt: true },
  });

  await logActivity({
    action: `newsletter.${action}`,
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'newsletter',
    targetId: created.id,
    detail: `${audience} · ${writtenNewsletterLocales(content).join(',')}`.slice(0, 191),
  });

  // Sent inline so the admin sees the real tallies on the button they pressed,
  // the same way the announcement broadcast reports its own fan-out.
  const dispatch = action === 'send' ? await dispatchNewsletter(created.id) : null;

  return NextResponse.json(
    {
      id: created.id,
      status: dispatch ? 'SENT' : created.status,
      scheduledAt: created.scheduledAt,
      imageUrl: imageData ? newsletterImageUrl(created.id) : null,
      ...(dispatch ? { dispatch } : {}),
    },
    { status: 201 }
  );
}
