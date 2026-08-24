import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { z } from 'zod';
import { logActivity } from '@/lib/activity';
import { MAX_TAGS_PER_ORG, isValidTagName, normalizeTagName, tagKey } from '@/lib/tags';
import { isHexColor } from '@/lib/branding';

// The org's tag vocabulary (#887). Org-scoped by construction: every read and
// write is bounded by the caller's own orgId, never a client-supplied one, so a
// tenant cannot see — or attach — another tenant's labels.

// GET — the vocabulary plus how often each label is actually used. The count is
// what tells an admin which tags are load-bearing and which are somebody's
// abandoned experiment, so it is worth the join.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'ADMIN' && session.user.role !== 'MENTOR')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ tags: [] });
    const tags = await prisma.tag.findMany({
      where: { orgId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, color: true, createdAt: true, _count: { select: { users: true } } },
    });
    return NextResponse.json({
      tags: tags.map((t) => ({ id: t.id, name: t.name, color: t.color, usageCount: t._count.users })),
      limit: MAX_TAGS_PER_ORG,
    });
  });
}

const createSchema = z.object({
  name: z.string().min(1).max(80),
  color: z.string().max(9).optional().nullable(),
});

// POST — create a label. Mentors may create one as well as apply it: the person
// with the context to notice "these three all need a portfolio review" is
// usually the mentor, and forcing that through an admin means the observation
// is lost rather than recorded.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'ADMIN' && session.user.role !== 'MENTOR')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

    const parsed = createSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success || !isValidTagName(parsed.data.name)) {
      return NextResponse.json({ error: 'Validation failed', code: 'invalid_name' }, { status: 400 });
    }
    const name = normalizeTagName(parsed.data.name);
    const color = parsed.data.color?.trim();
    if (color && !isHexColor(color)) {
      return NextResponse.json({ error: 'Color must be a hex value like #2563eb', code: 'invalid_color' }, { status: 400 });
    }

    // Case-insensitive uniqueness: "React" and "react" are the same label, and
    // letting both exist is how a vocabulary stops meaning anything.
    const existing = await prisma.tag.findMany({ where: { orgId }, select: { id: true, name: true, color: true } });
    const clash = existing.find((t) => tagKey(t.name) === tagKey(name));
    if (clash) return NextResponse.json({ tag: clash, existing: true });

    if (existing.length >= MAX_TAGS_PER_ORG) {
      return NextResponse.json(
        { error: `An organization may have at most ${MAX_TAGS_PER_ORG} tags`, code: 'org_limit' },
        { status: 409 }
      );
    }

    const tag = await prisma.tag.create({
      data: { orgId, name, color: color || null, createdById: session.user.id },
      select: { id: true, name: true, color: true },
    });
    await logActivity({
      action: 'tag.created',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'tag',
      targetId: tag.id,
      detail: name,
      request,
    });
    return NextResponse.json({ tag }, { status: 201 });
  });
}
