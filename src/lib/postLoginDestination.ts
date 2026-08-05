import { prisma } from '@/lib/prisma';
import { roleHome } from '@/lib/roleHome';

export async function postLoginDestination(userId: string, role?: string | null): Promise<string> {
  if (role !== 'MENTOR') return roleHome(role);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { mentorOnboardingStatus: true },
  });
  return user?.mentorOnboardingStatus === 'PENDING' ? '/onboarding' : '/mentor';
}
