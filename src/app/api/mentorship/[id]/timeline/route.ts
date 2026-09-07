import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import {
  buildRelationTimeline,
  DEFAULT_TIMELINE_LIMIT,
  MAX_TIMELINE_LIMIT,
  type TimelineViewerRole,
} from '@/lib/relationTimeline';

// GET /api/mentorship/<id>/timeline — the merged history of one pairing (#1702).
//
// Query: ?kinds=stage,meeting  &limit=20  &cursor=<opaque from nextCursor>
//
// The merge, the ordering and the per-role redaction all happen in
// lib/relationTimeline.ts. This handler only answers "who is asking, and about
// which relation" — the same three-way check the relation detail route makes.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    return await withTenantScope(session, async () => {
      const relation = await prisma.mentorshipRelation.findUnique({
        where: { id },
        select: { id: true, mentorId: true, menteeId: true },
      });
      if (!relation) return NextResponse.json({ error: 'Relation not found' }, { status: 404 });

      // The viewer's role *for this relation*, not their global role: an admin
      // sees everything, a mentor or mentee only their own pairing. Admin wins
      // first so a dual-role admin never gets the narrower list.
      let role: TimelineViewerRole | null = null;
      if (session.user.role === 'ADMIN') role = 'ADMIN';
      else if (relation.mentorId === session.user.id) role = 'MENTOR';
      else if (relation.menteeId === session.user.id) role = 'MENTEE';
      if (!role) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

      const sp = new URL(request.url).searchParams;
      const kinds = sp.getAll('kinds').flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
      const rawLimit = Number(sp.get('limit'));
      const limit = Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(MAX_TIMELINE_LIMIT, Math.floor(rawLimit))
        : DEFAULT_TIMELINE_LIMIT;

      const page = await buildRelationTimeline({
        relationId: id,
        role,
        kinds,
        limit,
        cursor: sp.get('cursor'),
      });

      return NextResponse.json(page);
    });
  } catch (error) {
    console.error('Relation timeline error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
