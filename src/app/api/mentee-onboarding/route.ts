import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { ONBOARDING_STEPS, loadOnboardingState, pendingOnboardings } from '@/lib/menteeOnboarding';

// The mentor's onboarding wizard for a new mentee (#51).
//   GET             → every mentee still needing onboarding work
//   GET ?menteeId=  → that one checklist
//   PATCH           → tick/untick a step, or dismiss the wizard for this mentee

const patchSchema = z.object({
  menteeId: z.string().min(1),
  step: z.enum(ONBOARDING_STEPS).optional(),
  done: z.boolean().optional(),
  dismissed: z.boolean().optional(),
});

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
    const menteeId = new URL(request.url).searchParams.get('menteeId');
    if (menteeId) {
      const state = await loadOnboardingState(session.user.id, menteeId);
      if (!state) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      return NextResponse.json({ onboarding: state });
    }
    return NextResponse.json({ onboardings: await pendingOnboardings(session.user.id) });
  });
}

export async function PATCH(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
    const { menteeId, step, done, dismissed } = parsed.data;

    // Same authorization as reading: no mentorship and no shared project means
    // this mentee is none of the caller's business.
    const state = await loadOnboardingState(session.user.id, menteeId);
    if (!state) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const existing = await prisma.menteeOnboarding.findUnique({
      where: { mentorId_menteeId: { mentorId: session.user.id, menteeId } },
      select: { steps: true },
    });
    const steps: Record<string, boolean> =
      existing?.steps && typeof existing.steps === 'object' ? { ...(existing.steps as Record<string, boolean>) } : {};
    if (step) {
      if (done === false) delete steps[step];
      else steps[step] = true;
    }

    const allDone = ONBOARDING_STEPS.every((s) => steps[s] === true || state.steps[s].auto);

    await prisma.menteeOnboarding.upsert({
      where: { mentorId_menteeId: { mentorId: session.user.id, menteeId } },
      update: {
        steps,
        projectId: state.projectId,
        ...(dismissed === true ? { dismissedAt: new Date() } : dismissed === false ? { dismissedAt: null } : {}),
        completedAt: allDone ? new Date() : null,
      },
      create: {
        mentorId: session.user.id,
        menteeId,
        projectId: state.projectId,
        steps,
        ...(dismissed === true ? { dismissedAt: new Date() } : {}),
        ...(allDone ? { completedAt: new Date() } : {}),
      },
    });

    return NextResponse.json({ onboarding: await loadOnboardingState(session.user.id, menteeId) });
  });
}
