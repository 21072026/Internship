import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import {
  canonicalNewsletterContent,
  newsletterImageUrl,
  normalizeNewsletterContent,
  writtenNewsletterLocales,
} from '@/lib/newsletter';

/**
 * One issue: read it, edit it while it can still change, cancel it, delete it
 * (#1469).
 *
 * ── THE RULE THIS FILE ENFORCES ────────────────────────────────────────────
 * A SENT issue is immutable and undeletable.
 *
 * That is a deliberate difference from announcements, which *can* be edited
 * after the fact (#1162) — because an announcement's edit corrects a
 * notification still sitting in everyone's bell, i.e. it fixes what people are
 * about to read. A newsletter has already left the building. Editing the row
 * would not change a single delivered inbox; it would only make the archive
 * disagree with what was actually sent, and this module exists to keep that
 * record. So: edit the draft, cancel the schedule, and once it is out, it is
 * history.
 */

const patchSchema = z.object({
  audience: z.enum(['MENTEE', 'MENTOR', 'BOTH']).optional(),
  content: z.record(z.string(), z.unknown()).optional(),
  // Null clears the schedule and returns the issue to DRAFT.
  scheduledAt: z.string().datetime().nullable().optional(),
  // 'schedule' arms it, 'draft' disarms it, 'cancel' pulls it for good.
  action: z.enum(['schedule', 'draft', 'cancel']).optional(),
  removeImage: z.boolean().optional(),
});

// GET — the issue plus its delivery record. This is the "who was it sent to"
// view, so the per-recipient rows come with it.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const issue = await prisma.newsletter.findUnique({
    where: { id },
    select: {
      id: true, templateKey: true, audience: true, status: true, subject: true, content: true,
      scheduledAt: true, sentAt: true, createdById: true, recipientCount: true, sentCount: true,
      failedCount: true, skippedCount: true, createdAt: true,
      image: { select: { id: true } },
    },
  });
  if (!issue) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const sends = await prisma.newsletterSend.findMany({
    where: { newsletterId: id },
    orderBy: { sentAt: 'desc' },
    // Bounded: a 5 000-recipient issue must not turn this into a 5 000-row
    // payload. The counters on the issue carry the totals; this is the sample
    // an admin actually reads (and where the failures show up first).
    take: 200,
    select: { id: true, email: true, locale: true, status: true, error: true, sentAt: true },
  });

  const variants = normalizeNewsletterContent(issue.content);
  const { image, content: _content, ...rest } = issue;
  return NextResponse.json({
    newsletter: {
      ...rest,
      content: variants,
      languages: writtenNewsletterLocales(variants),
      createdBySystem: issue.createdById === 'system',
      imageUrl: image ? newsletterImageUrl(issue.id) : null,
    },
    sends,
    sendsTruncated: issue.recipientCount > sends.length,
  });
}

// PATCH — edit a draft, (re)schedule it, disarm it, or cancel it.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });

  const existing = await prisma.newsletter.findUnique({ where: { id }, select: { id: true, status: true, content: true } });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  // 409 rather than 403: the request is allowed, the issue's state is what
  // refuses it. SENDING is excluded too — editing an issue mid-flight would
  // send two different newsletters under one subject line.
  if (existing.status !== 'DRAFT' && existing.status !== 'SCHEDULED') {
    return NextResponse.json({ error: `A ${existing.status.toLowerCase()} newsletter can no longer be changed`, status: existing.status }, { status: 409 });
  }

  const data: Prisma.NewsletterUpdateInput = {};

  if (parsed.data.content) {
    const content = normalizeNewsletterContent(parsed.data.content);
    const canonical = canonicalNewsletterContent(content);
    if (!canonical) {
      return NextResponse.json(
        { error: 'Validation failed', details: { formErrors: ['At least one language needs a subject, an intro and one tip'] } },
        { status: 400 }
      );
    }
    data.content = content as unknown as Prisma.InputJsonValue;
    // The canonical subject is derived, never sent by the client: it has to
    // stay the default locale's actual subject line.
    data.subject = canonical.subject;
  }

  if (parsed.data.audience) data.audience = parsed.data.audience;
  if (parsed.data.scheduledAt !== undefined) data.scheduledAt = parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : null;
  if (parsed.data.removeImage) data.image = { delete: true };

  if (parsed.data.action === 'schedule') {
    const at = data.scheduledAt ?? null;
    if (!at) return NextResponse.json({ error: 'Validation failed', details: { formErrors: ['scheduledAt is required to schedule'] } }, { status: 400 });
    data.status = 'SCHEDULED';
  } else if (parsed.data.action === 'draft') {
    data.status = 'DRAFT';
    // A draft with a time still on it would look armed while being ignored.
    data.scheduledAt = null;
  } else if (parsed.data.action === 'cancel') {
    data.status = 'CANCELED';
    data.scheduledAt = null;
  }

  // `image: { delete: true }` throws P2025 when there is nothing attached —
  // an idempotent "remove the image" should not 500 on the second press.
  try {
    await prisma.newsletter.update({ where: { id }, data });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025' && parsed.data.removeImage) {
      const { image: _drop, ...withoutImage } = data;
      await prisma.newsletter.update({ where: { id }, data: withoutImage });
    } else {
      throw e;
    }
  }

  await logActivity({
    action: parsed.data.action === 'cancel' ? 'newsletter.canceled' : 'newsletter.updated',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'newsletter',
    targetId: id,
  });

  return NextResponse.json({ ok: true });
}

// DELETE — only a draft or a canceled issue. See the header: a sent issue is
// the record of what people received, and the module's job is to keep it.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const existing = await prisma.newsletter.findUnique({ where: { id }, select: { status: true } });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (existing.status !== 'DRAFT' && existing.status !== 'CANCELED') {
    return NextResponse.json({ error: 'A sent newsletter is part of the record and cannot be deleted', status: existing.status }, { status: 409 });
  }

  await prisma.newsletter.delete({ where: { id } });
  await logActivity({
    action: 'newsletter.deleted',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'newsletter',
    targetId: id,
  });
  return NextResponse.json({ ok: true });
}
