import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { dispatchWebhook } from '@/lib/webhooks';
import { checkActiveRelationLimit, planLimitError } from '@/lib/planGate';
import { getMentorAvailability } from '@/lib/mentorAvailability';
import { withTenantScope } from '@/lib/orgContext';
import { scopeForRole, logScopeDenial } from '@/lib/authzScope';
import { notify } from '@/lib/notify';
import { emailAllowed } from '@/lib/notificationPrefs';
import { sendMentorAssignedEmail, sendMenteeAssignedEmail } from '@/services/emailService';
import { resolveOrgId } from '@/lib/orgScope';

const createRelationSchema = z.object({
  mentorId: z.string().min(1),
  menteeId: z.string().min(1),
  companyId: z.string().optional(),
  projectId: z.string().optional(),
  startDate: z.string().optional(),
});

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (session.user.role === 'COMPANY' && !session.user.companyId) {
      return NextResponse.json({ error: 'Company assignment is required', code: 'company_not_assigned' }, { status: 403 });
    }
    const companyOrgId = session.user.role === 'COMPANY' ? resolveOrgId(session) : null;
    if (session.user.role === 'COMPANY' && !companyOrgId) {
      return NextResponse.json({ error: 'Organization is required', code: 'organization_required' }, { status: 403 });
    }

    // Bind the request's tenant so every query below is auto-scoped once
    // MT_ENFORCE_ISOLATION is on (no-op while it's off). See orgContext.ts (#543).
    return await withTenantScope(session, async () => {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const search = searchParams.get('search');
    // Pagination is opt-in: only applied when `page` is explicitly passed, so
    // the many callers that expect the full list (board views, mentee/mentor
    // dashboards, meeting/email composers) keep working unchanged.
    const pageParam = searchParams.get('page');
    const page = Math.max(1, parseInt(pageParam || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10) || 20));

    // Fail-closed scoping (#848): SOURCE was missing from this chain and read
    // every relation in the tenant. Roles without a defined scope are denied.
    // COMPANY stays read-only and limited to its own company's relations.
    const scope = await scopeForRole(session.user, 'relation');
    if (!scope) {
      await logScopeDenial(session.user, 'GET /api/mentorship');
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const where: Record<string, unknown> = {
      ...scope,
      ...(session.user.role === 'COMPANY' ? { orgId: companyOrgId, companyId: session.user.companyId } : {}),
    };

    if (status) {
      where.status = status;
    }
    if (search) {
      where.OR = [
        { mentor: { fullName: { contains: search } } },
        { mentee: { fullName: { contains: search } } },
        { company: { name: { contains: search } } },
      ];
    }

    const include = {
      mentor: { select: { id: true, fullName: true, email: true, department: true } },
      mentee: {
        select: {
          id: true,
          fullName: true,
          email: true,
          university: true,
          graduationYear: true,
          skills: true,
          // So the screens that write TO a mentee — the bulk email composer
          // above all — can show which language they read (#1164).
          preferredLanguage: true,
          // Same idea for the clock they read (#1210): the scheduler previews
          // the picked time on every selected mentee's zone before inviting.
          timezone: true,
        },
      },
      company: { select: { id: true, name: true, industry: true } },
      _count: { select: { interactions: true } },
    };

    if (!pageParam) {
      const relations = await prisma.mentorshipRelation.findMany({ where, include, orderBy: { startDate: 'desc' } });
      return NextResponse.json({ relations });
    }

    const [total, relations] = await Promise.all([
      prisma.mentorshipRelation.count({ where }),
      prisma.mentorshipRelation.findMany({
        where,
        include,
        orderBy: { startDate: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return NextResponse.json({ relations, total, page, pageSize });
    });
  } catch (error) {
    console.error('Get mentorships error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return await withTenantScope(session, async () => {
    const body = await request.json();
    const parsed = createRelationSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { mentorId, menteeId, companyId, projectId, startDate } = parsed.data;

    const [mentor, mentee] = await Promise.all([
      prisma.user.findUnique({ where: { id: mentorId } }),
      prisma.user.findUnique({ where: { id: menteeId } }),
    ]);

    // Either side may be an admin, a mentor or a mentee (#1141): admins mentor,
    // and someone who mentors can still need mentoring themselves. What stays
    // barred is the COMPANY/SOURCE observer roles — they have no personal
    // mentorship — and pairing someone with themselves.
    const PARTICIPANT_ROLES = ['ADMIN', 'MENTOR', 'MENTEE'];

    if (!mentor || !PARTICIPANT_ROLES.includes(mentor.role)) {
      return NextResponse.json({ error: 'Invalid mentor' }, { status: 400 });
    }

    if (!mentee || !PARTICIPANT_ROLES.includes(mentee.role)) {
      return NextResponse.json({ error: 'Invalid mentee' }, { status: 400 });
    }

    if (mentorId === menteeId) {
      return NextResponse.json({ error: 'A user cannot mentor themselves' }, { status: 400 });
    }

    const existingActive = await prisma.mentorshipRelation.findFirst({
      where: { menteeId, status: 'ACTIVE' },
    });

    if (existingActive) {
      return NextResponse.json(
        { error: 'This mentee already has an active mentorship relation' },
        { status: 409 }
      );
    }

    // Plan gate (#547): block a new active relation once the tenant is at its
    // plan limit. No-op for the unlimited default org; existing mentees are
    // never affected.
    const gate = await checkActiveRelationLimit(mentee.orgId);
    if (!gate.allowed) {
      return NextResponse.json(planLimitError(gate), { status: 403 });
    }

    // Capacity/availability warning (#942): advisory only, never blocking — the
    // plan gate above is the only thing that can refuse the assignment. Counted
    // *before* this new relation is created, so it reflects the mentor's load
    // going into the assignment, not after it. Single source of truth for the
    // derivation: getMentorAvailability() (#941).
    const activeMenteeCount = await prisma.mentorshipRelation.count({
      where: { mentorId, status: 'ACTIVE' },
    });
    const availability = getMentorAvailability({
      mentorCapacity: mentor.mentorCapacity,
      activeMenteeCount,
      acceptingMentees: mentor.acceptingMentees,
    });
    const warnings: string[] =
      availability.status === 'at_capacity'
        ? ['mentor_at_capacity']
        : availability.status === 'not_accepting'
          ? ['mentor_not_accepting']
          : [];

    const relation = await prisma.mentorshipRelation.create({
      data: {
        mentorId,
        menteeId,
        orgId: mentee.orgId,
        companyId: companyId || null,
        projectId: projectId || null,
        startDate: startDate ? new Date(startDate) : new Date(),
      },
      include: {
        mentor: { select: { id: true, fullName: true, email: true } },
        mentee: { select: { id: true, fullName: true, email: true } },
        company: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } },
      },
    });

    await dispatchWebhook('mentorship.created', { relationId: relation.id, mentorId, menteeId, companyId: companyId || null });

    // A direct admin assignment used to be completely silent — neither side heard
    // about it until they happened to log in (#668). In-app is unconditional,
    // email honors the `mentorship` opt-out and never fails the assignment.
    await notify(mentee.id, 'mentorship_request.mentorAssigned', { mentorName: mentor.fullName }, '/portal');
    await notify(mentor.id, 'mentorship_request.menteeAssigned', { menteeName: mentee.fullName }, '/mentor');

    if (mentee.email && emailAllowed(mentee, 'mentorship')) {
      try {
        await sendMentorAssignedEmail({
          to: mentee.email,
          menteeName: mentee.fullName,
          mentorName: mentor.fullName,
          orgId: mentee.orgId,
        });
      } catch (e) {
        console.error('Mentor assignment email failed:', e);
      }
    }
    if (mentor.email && emailAllowed(mentor, 'mentorship')) {
      try {
        await sendMenteeAssignedEmail({
          to: mentor.email,
          mentorName: mentor.fullName,
          menteeName: mentee.fullName,
          orgId: mentor.orgId,
        });
      } catch (e) {
        console.error('Mentee assignment email failed:', e);
      }
    }

    return NextResponse.json({ relation, warnings }, { status: 201 });
    });
  } catch (error) {
    console.error('Create mentorship error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
