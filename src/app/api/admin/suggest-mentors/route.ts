import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { scoreMentors } from '@/lib/matching';

// GET ?menteeId= — admin: ranked mentor suggestions for a mentee by skill
// overlap and current load.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const menteeId = new URL(request.url).searchParams.get('menteeId') || '';
  const mentee = await prisma.user.findUnique({ where: { id: menteeId }, select: { skills: true } });
  if (!mentee) return NextResponse.json({ error: 'Mentee not found' }, { status: 404 });

  const mentors = await prisma.user.findMany({
    // Exclude mentors already mentoring this mentee.
    where: { role: 'MENTOR', isActive: true, NOT: { mentorRelations: { some: { menteeId } } } },
    select: { id: true, fullName: true, skills: true, _count: { select: { mentorRelations: true } } },
  });

  const menteeSkills = Array.isArray(mentee.skills) ? (mentee.skills as string[]) : [];
  const ranked = scoreMentors(
    menteeSkills,
    mentors.map((m) => ({
      id: m.id,
      fullName: m.fullName,
      skills: Array.isArray(m.skills) ? (m.skills as string[]) : [],
      activeCount: m._count.mentorRelations,
    }))
  );

  return NextResponse.json({ suggestions: ranked.slice(0, 5) });
}
