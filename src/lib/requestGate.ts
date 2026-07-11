import { prisma } from '@/lib/prisma';

// Gate for mentee mentorship requests (#591): a request may only be submitted
// once the essential onboarding steps are done. Mirrors the mentee steps of
// /api/onboarding (profile = university + skills, cv = uploaded CV file) so
// the checklist and the gate can never disagree.
export interface RequestGate {
  profile: boolean;
  cv: boolean;
  complete: boolean;
  missing: ('profile' | 'cv')[];
}

export async function getMenteeRequestGate(userId: string): Promise<RequestGate> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { university: true, skills: true, cvFile: { select: { id: true } } },
  });
  const skills = Array.isArray(user?.skills) ? (user!.skills as unknown[]) : [];
  const profile = !!(user?.university && skills.length > 0);
  const cv = !!user?.cvFile;
  const missing: ('profile' | 'cv')[] = [];
  if (!profile) missing.push('profile');
  if (!cv) missing.push('cv');
  return { profile, cv, complete: missing.length === 0, missing };
}
