import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';

// GET — role-aware first-run checklist state for the current user.
// Returns ordered steps with { key, done, href }.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const { id, role } = session.user;

    if (role === 'MENTEE') {
      const user = await prisma.user.findUnique({
        where: { id },
        select: { university: true, skills: true, publicProfile: true, cvFile: { select: { id: true } } },
      });
      const skills = Array.isArray(user?.skills) ? (user!.skills as unknown[]) : [];
      return NextResponse.json({
        role,
        steps: [
          { key: 'profile', done: !!(user?.university && skills.length > 0), href: '/portal/profile' },
          { key: 'cv', done: !!user?.cvFile, href: '/portal/profile' },
          { key: 'public', done: !!user?.publicProfile, href: '/portal/profile' },
        ],
      });
    }

    if (role === 'MENTOR' && new URL(request.url).searchParams.get('variant') === 'mentor-profile') {
      const [user, availability] = await Promise.all([
        prisma.user.findUnique({
          where: { id },
          select: { bio: true, interests: true, skills: true, mentorCapacity: true },
        }),
        prisma.availabilitySlot.count({ where: { mentorId: id } }),
      ]);
      const skills = Array.isArray(user?.skills)
        ? user.skills.filter((skill): skill is string => typeof skill === 'string' && skill.trim().length > 0)
        : [];
      return NextResponse.json({
        role,
        variant: 'mentor-profile',
        steps: [
          { key: 'mentorProfile', done: !!user?.bio?.trim(), href: '/mentor/profile' },
          { key: 'mentorExpertise', done: !!user?.interests?.trim() && skills.length > 0, href: '/mentor/profile' },
          { key: 'mentorCapacity', done: user?.mentorCapacity != null, href: '/mentor/profile' },
          { key: 'mentorAvailability', done: availability > 0, href: '/mentor/availability' },
        ],
      });
    }

    if (role === 'MENTOR') {
      const [mentees, interactions, meetings] = await Promise.all([
        prisma.mentorshipRelation.count({ where: { mentorId: id } }),
        prisma.interactionLog.count({ where: { relation: { mentorId: id } } }),
        prisma.meeting.count({ where: { relation: { mentorId: id } } }),
      ]);
      return NextResponse.json({
        role,
        steps: [
          { key: 'addMentee', done: mentees > 0, href: '/mentor/mentees/new' },
          { key: 'logInteraction', done: interactions > 0, href: '/mentor/mentees' },
          { key: 'scheduleMeeting', done: meetings > 0, href: '/mentor/meetings', optional: true },
        ].slice(0, mentees > 0 ? 3 : 2),
      });
    }

    if (role === 'ADMIN') {
      const [companies, nonAdmins, relations] = await Promise.all([
        prisma.company.count(),
        prisma.user.count({ where: { role: { not: 'ADMIN' } } }),
        prisma.mentorshipRelation.count(),
      ]);
      return NextResponse.json({
        role,
        steps: [
          { key: 'addCompany', done: companies > 0, href: '/admin/companies' },
          { key: 'inviteUser', done: nonAdmins > 0, href: '/admin/invite' },
          { key: 'assignMentorship', done: relations > 0, href: '/admin/mentorship' },
        ],
      });
    }

    return NextResponse.json({ role, steps: [] });
  });
}

export async function PUT(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'MENTOR') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await request.json().catch(() => null);
  if (!body || body.action !== 'skip' || Object.keys(body).some((key) => key !== 'action')) {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  }
  await prisma.user.update({
    where: { id: session.user.id },
    data: { mentorOnboardingStatus: 'SKIPPED' },
  });
  return NextResponse.json({ ok: true });
}
