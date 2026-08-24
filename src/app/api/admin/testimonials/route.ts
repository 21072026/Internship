import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { notify } from '@/lib/notify';
import { logActivity } from '@/lib/activity';
import { hasConsent } from '@/lib/consent';
import { withTenantScope } from '@/lib/orgContext';

// Testimonial moderation (#1098). The pool NEVER shows an evaluation unless
// BOTH the author and the subject hold an active TESTIMONIAL consent —
// moderation does not override consent, not even for an admin's eyes. The
// original comment is never modified: the admin drafts publicExcerpt, the
// author approves that exact wording, and only then can publish succeed.

const ACTIVE_CONSENT = {
  consents: { some: { type: 'TESTIMONIAL' as const, grantedAt: { not: null }, revokedAt: null } },
};

// GET — the moderation pool, bucketed client-side by state:
//   candidate: consented + comment present, no excerpt yet
//   pending:   excerpt drafted, author approval outstanding
//   approved:  author approved, not yet published
//   published: live
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return await withTenantScope(session, async () => {
    const rows = await prisma.evaluation.findMany({
      where: {
        comment: { not: null },
        // Both relation sides must hold the consent — this covers the author
        // when the author is a participant; admin-authored rows are filtered
        // out below (no participant author to attribute the quote to).
        relation: { mentor: ACTIVE_CONSENT, mentee: ACTIVE_CONSENT },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        comment: true,
        publicExcerpt: true,
        excerptApprovedAt: true,
        publishedAt: true,
        sharedPublicly: true,
        createdAt: true,
        authorId: true,
        relation: {
          select: {
            mentorId: true,
            menteeId: true,
            mentor: { select: { id: true, fullName: true } },
            mentee: { select: { id: true, fullName: true } },
          },
        },
      },
    });
    const testimonials = rows
      // The `where` already requires a relation with consenting sides, so this
      // narrowing only tells the compiler what the query guarantees. An
      // interview scorecard (#824) has no relation at all and is therefore
      // never a testimonial — which is exactly right: it was written about a
      // candidate, not about a mentorship.
      .filter((e): e is typeof e & { relation: NonNullable<typeof e.relation> } => !!e.relation)
      .filter((e) => e.authorId === e.relation.mentorId || e.authorId === e.relation.menteeId)
      .map((e) => ({
        id: e.id,
        comment: e.comment,
        publicExcerpt: e.publicExcerpt,
        excerptApprovedAt: e.excerptApprovedAt,
        publishedAt: e.publishedAt,
        createdAt: e.createdAt,
        authorName: e.authorId === e.relation.mentorId ? e.relation.mentor.fullName : e.relation.mentee.fullName,
        authorRole: e.authorId === e.relation.mentorId ? 'mentor' : 'mentee',
        subjectName: e.authorId === e.relation.mentorId ? e.relation.mentee.fullName : e.relation.mentor.fullName,
      }));
    return NextResponse.json({ testimonials });
  });
}

const patchSchema = z.object({
  evaluationId: z.string().min(1),
  action: z.enum(['saveExcerpt', 'publish', 'unpublish']),
  excerpt: z.string().max(1000).optional(),
});

// PATCH — the three moderation moves. Publish is server-side strict: excerpt
// present, author approval present, both consents STILL active.
export async function PATCH(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return await withTenantScope(session, async () => {
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    const { evaluationId, action, excerpt } = parsed.data;

    const evaluation = await prisma.evaluation.findUnique({
      where: { id: evaluationId },
      select: {
        id: true,
        authorId: true,
        publicExcerpt: true,
        excerptApprovedAt: true,
        relation: { select: { mentorId: true, menteeId: true } },
      },
    });
    if (!evaluation) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    // A relation-less row is an interview scorecard (#824), never a testimonial:
    // there are no two consenting mentorship sides to attribute a quote to.
    if (!evaluation.relation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    if (action === 'saveExcerpt') {
      const text = excerpt?.trim();
      if (!text) return NextResponse.json({ error: 'Excerpt is required' }, { status: 400 });
      // Every edit invalidates a previous approval — the author approves an
      // exact wording, not the idea of one.
      await prisma.evaluation.update({
        where: { id: evaluationId },
        data: { publicExcerpt: text, excerptApprovedAt: null, publishedAt: null, sharedPublicly: false },
      });
      await notify(evaluation.authorId, 'testimonial.approvalRequested', {}, '/testimonials/approve');
      await logActivity({
        action: 'testimonial.excerpt_drafted',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'evaluation',
        targetId: evaluationId,
        request,
      });
      return NextResponse.json({ ok: true });
    }

    if (action === 'publish') {
      if (!evaluation.publicExcerpt?.trim()) {
        return NextResponse.json({ error: 'No excerpt to publish', code: 'no_excerpt' }, { status: 400 });
      }
      if (!evaluation.excerptApprovedAt) {
        return NextResponse.json({ error: 'The author has not approved this excerpt', code: 'not_approved' }, { status: 400 });
      }
      // Consents may have been revoked since drafting — re-check both sides.
      const [mentorOk, menteeOk] = await Promise.all([
        hasConsent(evaluation.relation.mentorId, 'TESTIMONIAL'),
        hasConsent(evaluation.relation.menteeId, 'TESTIMONIAL'),
      ]);
      if (!mentorOk || !menteeOk) {
        return NextResponse.json({ error: 'Consent is no longer active', code: 'consent_missing' }, { status: 400 });
      }
      await prisma.evaluation.update({
        where: { id: evaluationId },
        data: { publishedAt: new Date(), sharedPublicly: true },
      });
      await logActivity({
        action: 'testimonial.publish',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'evaluation',
        targetId: evaluationId,
        request,
      });
      return NextResponse.json({ ok: true });
    }

    // unpublish
    await prisma.evaluation.update({
      where: { id: evaluationId },
      data: { publishedAt: null, sharedPublicly: false },
    });
    await logActivity({
      action: 'testimonial.unpublish',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'evaluation',
      targetId: evaluationId,
      request,
    });
    return NextResponse.json({ ok: true });
  });
}
