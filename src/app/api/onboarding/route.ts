import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';

// GET — role-aware first-run checklist state for the current user.
// Returns ordered steps with { key, done, href }.
export async function GET() {
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

    if (role === 'MENTOR') {
      const [user, availabilitySlots] = await Promise.all([
        prisma.user.findUnique({
          where: { id },
          select: { bio: true, interests: true, skills: true, mentorCapacity: true },
        }),
        prisma.availabilitySlot.count({ where: { mentorId: id } }),
      ]);
      const skills = Array.isArray(user?.skills) ? (user!.skills as unknown[]) : [];
      return NextResponse.json({
        role,
        steps: [
          { key: 'bio', done: !!user?.bio?.trim(), href: '/mentor/profile' },
          { key: 'interestsOrSkills', done: !!user?.interests?.trim() || skills.length > 0, href: '/mentor/profile' },
          { key: 'mentorCapacity', done: user?.mentorCapacity != null, href: '/mentor/profile' },
          { key: 'availability', done: availabilitySlots > 0, href: '/mentor/availability' },
        ],
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
