import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { z } from 'zod';
import { MAX_TAGS_PER_USER } from '@/lib/tags';

// Put a label on somebody, or take it off (#887).
//
// AUTHORISATION — mentors may tag their OWN mentees, admins anyone.
// The person with the context to notice what is worth marking is usually the
// mentor; routing that through an admin means the observation never gets
// recorded. It is bounded, though: a mentor can only label people they already
// have a relationship with, and only with the org's existing vocabulary.
const schema = z.object({
  userId: z.string().min(1),
  tagId: z.string().min(1),
  action: z.enum(['add', 'remove']),
});

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'ADMIN' && session.user.role !== 'MENTOR')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
    const parsed = schema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }
    const { userId, tagId, action } = parsed.data;
    const orgId = resolveOrgId(session);

    // The tag must belong to the caller's own org — a tag id from elsewhere is
    // "not found", never silently applied.
    const tag = await prisma.tag.findFirst({ where: { id: tagId, orgId: orgId ?? undefined }, select: { id: true } });
    if (!tag) return NextResponse.json({ error: 'Tag not found' }, { status: 404 });

    const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, orgId: true } });
    if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 });
    if (orgId && target.orgId && target.orgId !== orgId) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if (session.user.role === 'MENTOR') {
      const mine = await prisma.mentorshipRelation.count({
        where: { mentorId: session.user.id, menteeId: userId },
      });
      if (mine === 0) {
        return NextResponse.json({ error: 'You can only tag your own mentees', code: 'not_your_mentee' }, { status: 403 });
      }
    }

    if (action === 'remove') {
      await prisma.userTag.deleteMany({ where: { userId, tagId } });
      return NextResponse.json({ ok: true, tagged: false });
    }

    const current = await prisma.userTag.count({ where: { userId } });
    const already = await prisma.userTag.count({ where: { userId, tagId } });
    if (already === 0 && current >= MAX_TAGS_PER_USER) {
      return NextResponse.json(
        { error: `A person may carry at most ${MAX_TAGS_PER_USER} tags`, code: 'user_limit' },
        { status: 409 }
      );
    }

    // Idempotent: applying a label twice is a no-op, not an error — the UI
    // toggles and a double click should not fail.
    await prisma.userTag.upsert({
      where: { userId_tagId: { userId, tagId } },
      update: {},
      create: { userId, tagId, addedById: session.user.id },
    });
    return NextResponse.json({ ok: true, tagged: true });
  });
}
