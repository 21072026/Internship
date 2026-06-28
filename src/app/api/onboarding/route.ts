import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

// GET — role-aware first-run checklist state for the current user.
// Returns ordered steps with { key, done, href }.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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

  if (role === 'MENTOR') {
    const [mentees, interactions] = await Promise.all([
      prisma.mentorshipRelation.count({ where: { mentorId: id } }),
      prisma.interactionLog.count({ where: { relation: { mentorId: id } } }),
    ]);
    return NextResponse.json({
      role,
      steps: [
        { key: 'addMentee', done: mentees > 0, href: '/mentor/mentees/new' },
        { key: 'logInteraction', done: interactions > 0, href: '/mentor/mentees' },
        { key: 'scheduleMeeting', done: false, href: '/mentor/meetings', optional: true },
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
}
