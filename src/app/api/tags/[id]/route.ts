import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { z } from 'zod';
import { isValidTagName, normalizeTagName, tagKey } from '@/lib/tags';
import { isHexColor } from '@/lib/branding';

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  color: z.string().max(9).nullable().optional(),
});

// PATCH — rename or recolour a label (#845).
//
// Renaming in place rather than "delete and create again" is the whole point:
// the label keeps its id, so every person who carries it keeps carrying it and
// every saved view that filters on it keeps working. Fixing a typo must not
// silently empty somebody's saved segment.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return await withTenantScope(session, async () => {
    const { id } = await params;
    const orgId = resolveOrgId(session);
    const tag = await prisma.tag.findFirst({ where: { id, orgId: orgId ?? undefined }, select: { id: true, name: true } });
    if (!tag) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const parsed = patchSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }
    const data: { name?: string; color?: string | null } = {};

    if (parsed.data.name !== undefined) {
      if (!isValidTagName(parsed.data.name)) {
        return NextResponse.json({ error: 'Invalid tag name', code: 'invalid_name' }, { status: 400 });
      }
      const name = normalizeTagName(parsed.data.name);
      // Uniqueness is decided case-insensitively (lib/tags), so the check has to
      // be too — otherwise "React" could be renamed to "react" and sit beside
      // itself, which is exactly the drift merge exists to clean up.
      // Compared in JS rather than by the database, because the uniqueness key
      // is tagKey() (Turkish-aware lowercase), which MySQL's collation does not
      // reproduce — `İ` and `I` are the case that breaks a naive comparison.
      const siblings = await prisma.tag.findMany({
        where: { orgId: orgId ?? undefined, id: { not: tag.id } },
        select: { id: true, name: true },
      });
      const clash = siblings.find((t) => tagKey(t.name) === tagKey(name)) ?? null;
      if (clash) {
        return NextResponse.json(
          { error: 'A tag with that name already exists', code: 'duplicate', tagId: clash.id },
          { status: 409 }
        );
      }
      data.name = name;
    }

    if (parsed.data.color !== undefined) {
      if (parsed.data.color && !isHexColor(parsed.data.color)) {
        return NextResponse.json({ error: 'Invalid colour', code: 'invalid_color' }, { status: 400 });
      }
      data.color = parsed.data.color || null;
    }

    if (Object.keys(data).length === 0) return NextResponse.json({ error: 'Nothing to change' }, { status: 400 });

    const updated = await prisma.tag.update({ where: { id: tag.id }, data, select: { id: true, name: true, color: true } });
    await logActivity({
      action: 'tag.updated',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'tag',
      targetId: tag.id,
      detail: data.name && data.name !== tag.name ? `${tag.name} → ${data.name}` : updated.name,
      request,
    });
    return NextResponse.json({ tag: updated });
  });
}

// DELETE — retire a label.
//
// This removes the TAG and the UserTag rows that point at it. It does not, and
// must not, touch the people who carried it: a label is an opinion about
// somebody, and deleting the opinion is not deleting them. The schema enforces
// the same thing (UserTag cascades from Tag; User does not).
//
// Admin-only. Creating and applying a label is everyday work a mentor should
// do; removing one from the org's whole vocabulary erases it from every person
// at once, which is an admin decision.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return await withTenantScope(session, async () => {
    const { id } = await params;
    const orgId = resolveOrgId(session);
    // Scoped lookup, not a bare findUnique: an id from another tenant must read
    // as "not found", never as "deleted".
    const tag = await prisma.tag.findFirst({ where: { id, orgId: orgId ?? undefined }, select: { id: true, name: true } });
    if (!tag) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const removed = await prisma.userTag.count({ where: { tagId: tag.id } });
    await prisma.tag.delete({ where: { id: tag.id } });
    await logActivity({
      action: 'tag.deleted',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'tag',
      targetId: tag.id,
      detail: `${tag.name} · removed from ${removed} people`,
      request,
    });
    return NextResponse.json({ ok: true, removedFrom: removed });
  });
}
