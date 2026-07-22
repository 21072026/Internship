import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { isAiConfigured } from '@/lib/cvExtractAi';
import { aiInterviewPrep } from '@/lib/aiInterviewPrep';
import { runAiGated } from '@/lib/aiGate';
import { withTenantScope } from '@/lib/orgContext';

// AI interview-prep assistant (Faz 2, #536) — mentee-facing and FREE for the
// mentee: cost is metered on the org's AI quota; quota exhaustion surfaces as
// a neutral "temporarily unavailable", never a paywall. Self-service only —
// the mentee triggers it for themselves, and only position/skills strings are
// sent to the provider (no identifiers, no CV).

// GET — availability: the portal card hides itself when no provider is set.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
    return NextResponse.json({ configured: isAiConfigured() });
  });
}

const schema = z.object({
  position: z.string().max(120).optional(),
  focus: z.string().max(300).optional(),
});

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'MENTEE') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  return await withTenantScope(session, async () => {
    const parsed = schema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

    const me = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { targetPosition: true, skills: true },
    });
    const position = (parsed.data.position || me?.targetPosition || '').trim();
    if (!position) return NextResponse.json({ error: 'No target position', code: 'no_position' }, { status: 400 });
    const skills = Array.isArray(me?.skills) ? (me!.skills as string[]) : [];

    const gated = await runAiGated({
      scope: 'interview_prep',
      userId: session.user.id,
      call: () => aiInterviewPrep(position, skills, parsed.data.focus),
    });

    if (!gated.ok) {
      if (gated.reason === 'quota_exceeded') {
        return NextResponse.json({ error: 'Temporarily unavailable', code: 'quota_exceeded' }, { status: 429 });
      }
      return NextResponse.json({ error: 'AI is not configured', code: 'not_configured' }, { status: 501 });
    }
    return NextResponse.json({ prep: gated.result });
  });
}
