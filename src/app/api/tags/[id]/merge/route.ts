import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { z } from 'zod';

const schema = z.object({ into: z.string().min(1) });

/**
 * POST — fold this label into another one (#845).
 *
 * Caps stop the vocabulary growing without limit; merge is the only thing that
 * cleans up the drift that already happened. "Backend", "back-end" and
 * "Back End" are one idea written three ways, and without a merge the only ways
 * out are to live with the split or to delete two of them and lose who carried
 * them. Merge keeps every marking and ends up with one label.
 *
 * Everyone on the source ends up on the target; the source is then deleted.
 * Nobody loses a marking, and nobody gains a duplicate — the (userId, tagId)
 * unique means someone already carrying both simply keeps the one.
 *
 * Admin-only, like delete: it rewrites the org's whole vocabulary at once.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return await withTenantScope(session, async () => {
    const { id } = await params;
    const orgId = resolveOrgId(session);

    const parsed = schema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }
    if (parsed.data.into === id) {
      return NextResponse.json({ error: 'A tag cannot be merged into itself', code: 'same_tag' }, { status: 400 });
    }

    // Both ends scoped to the caller's org: a merge that could name a foreign
    // id would be a way to move markings between tenants.
    const [source, target] = await Promise.all([
      prisma.tag.findFirst({ where: { id, orgId: orgId ?? undefined }, select: { id: true, name: true } }),
      prisma.tag.findFirst({ where: { id: parsed.data.into, orgId: orgId ?? undefined }, select: { id: true, name: true } }),
    ]);
    if (!source || !target) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const result = await prisma.$transaction(async (tx) => {
      const holders = await tx.userTag.findMany({ where: { tagId: source.id }, select: { userId: true, addedById: true } });
      const already = new Set(
        (await tx.userTag.findMany({
          where: { tagId: target.id, userId: { in: holders.map((h) => h.userId) } },
          select: { userId: true },
        })).map((r) => r.userId)
      );
      const toMove = holders.filter((h) => !already.has(h.userId));
      if (toMove.length > 0) {
        await tx.userTag.createMany({
          // The original tagger is carried over, not replaced by the admin doing
          // the merge: who noticed this about this person is the fact worth
          // keeping, and the merge is bookkeeping.
          data: toMove.map((h) => ({ userId: h.userId, tagId: target.id, addedById: h.addedById })),
          skipDuplicates: true,
        });
      }
      // Deleting the source takes its UserTag rows with it (cascade), which is
      // correct now that every one of them has an equivalent on the target.
      await tx.tag.delete({ where: { id: source.id } });
      return { moved: toMove.length, alreadyHad: already.size };
    });

    await logActivity({
      action: 'tag.merged',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'tag',
      targetId: target.id,
      detail: `${source.name} → ${target.name} · ${result.moved} moved, ${result.alreadyHad} already had it`,
      request,
    });

    return NextResponse.json({ ok: true, into: target.id, ...result });
  });
}
