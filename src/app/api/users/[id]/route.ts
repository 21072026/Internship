import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { withTenantScope } from '@/lib/orgContext';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return await withTenantScope(session, async () => {
      const user = await prisma.user.findUnique({
        where: { id },
        select: {
          id: true,
          email: true,
          fullName: true,
          role: true,
          phone: true,
          whatsapp: true,
          city: true,
          birthDate: true,
          referralSource: true,
          sourceId: true,
          referredById: true,
          referredBy: { select: { id: true, fullName: true, role: true } },
          source: { select: { id: true, name: true } },
          university: true,
          department: true,
          graduationYear: true,
          skills: true,
          cvUrl: true,
          createdAt: true,
          mentorCapacity: true,
          // For mentor detail: their active mentees, pipeline stage, and the raw
          // evaluation scores (averaged on the client for a workload/quality view).
          mentorRelations: {
            orderBy: { startDate: 'desc' },
            select: {
              id: true,
              status: true,
              pipelineStatus: true,
              startDate: true,
              mentee: { select: { id: true, fullName: true, email: true } },
              company: { select: { name: true } },
              evaluations: { select: { scores: true } },
            },
          },
          menteeRelations: {
            orderBy: { startDate: 'desc' },
            include: {
              mentor: { select: { fullName: true, email: true } },
              company: { select: { name: true, industry: true } },
              project: { select: { id: true, name: true } },
              cohort: { select: { id: true, name: true } },
              interactions: { orderBy: { date: 'desc' } },
              statusChanges: {
                orderBy: { createdAt: 'desc' },
                include: { changedBy: { select: { fullName: true } } },
              },
            },
          },
        },
      });

      if (!user) {
        return NextResponse.json({ error: 'User not found' }, { status: 404 });
      }

      return NextResponse.json({ user });
    });
  } catch (error) {
    console.error('Get user error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PATCH — admin updates a user's account flags (currently: active/inactive).
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return await withTenantScope(session, async () => {
      const body = await request.json();
      const data: {
        isActive?: boolean;
        sourceId?: string | null;
        referredById?: string | null;
        skills?: string[];
        mentorCapacity?: number | null;
      } = {};

      if (typeof body.isActive === 'boolean') {
        // Guard against an admin locking themselves out.
        if (id === session.user.id && body.isActive === false) {
          return NextResponse.json({ error: 'You cannot deactivate your own account' }, { status: 400 });
        }
        data.isActive = body.isActive;
      }

      // Assign / clear the mentee's referral source.
      if ('sourceId' in body && (typeof body.sourceId === 'string' || body.sourceId === null)) {
        data.sourceId = body.sourceId || null;
      }

      // Who brought this person in (#51). Any person — mentee, mentor or admin —
      // can be the source, so this is a plain user pointer rather than a Source
      // row; it is also set automatically by invitation/referral links. Self-
      // reference would make the "who referred whom" tree lie.
      if ('referredById' in body && (typeof body.referredById === 'string' || body.referredById === null)) {
        const target = body.referredById || null;
        if (target === id) {
          return NextResponse.json({ error: 'A user cannot be their own source' }, { status: 400 });
        }
        if (target) {
          const referrer = await prisma.user.findUnique({ where: { id: target }, select: { role: true } });
          if (!referrer || !['ADMIN', 'MENTOR', 'MENTEE'].includes(referrer.role)) {
            return NextResponse.json({ error: 'Invalid source user' }, { status: 400 });
          }
        }
        data.referredById = target;
      }

      // Mentor expertise (skills) — admin can populate so skill-match works.
      if (Array.isArray(body.skills) && body.skills.every((s: unknown) => typeof s === 'string')) {
        data.skills = [...new Set((body.skills as string[]).map((s) => s.trim()).filter(Boolean))];
      }

      // Mentor active-mentee capacity (null clears it).
      if ('mentorCapacity' in body) {
        const c = body.mentorCapacity;
        if (c === null || c === '') {
          data.mentorCapacity = null;
        } else if (typeof c === 'number' && Number.isInteger(c) && c >= 0 && c <= 999) {
          data.mentorCapacity = c;
        } else {
          return NextResponse.json({ error: 'Invalid mentorCapacity' }, { status: 400 });
        }
      }

      if (Object.keys(data).length === 0) {
        return NextResponse.json({ error: 'No supported fields to update' }, { status: 400 });
      }

      const user = await prisma.user.update({
        where: { id },
        data,
        select: { id: true, isActive: true, sourceId: true, referredById: true, skills: true, mentorCapacity: true },
      });

      // Activation state is the security-relevant part of this endpoint — it is
      // what lets someone in or keeps them out — so it gets its own audit row
      // at warning level (#878). Skills/capacity/source edits are routine.
      if (typeof data.isActive === 'boolean') {
        await logActivity({
          action: data.isActive ? 'user.activated' : 'user.deactivated',
          level: 'warning',
          actorId: session.user.id,
          actorEmail: session.user.email ?? null,
          targetType: 'user',
          targetId: id,
          request,
        });
      }

      return NextResponse.json({ user });
    });
  } catch (error) {
    console.error('Update user error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
