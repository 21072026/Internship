import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { isAiConfigured } from '@/lib/ai/provider';
import { aiInterviewPrep } from '@/lib/aiInterviewPrep';
import { runAiGated } from '@/lib/aiGate';
import { withTenantScope } from '@/lib/orgContext';
import { enforceRateLimit } from '@/lib/rateLimit';
import { AI_RATE_LIMITS } from '@/lib/ai/limits';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { hashInput, latestArtifact, toArtifactDto } from '@/lib/ai/artifacts';

// AI interview-prep assistant (Faz 2, #536) — mentee-facing and FREE for the
// mentee: cost is metered on the org's AI quota; quota exhaustion surfaces as
// a neutral "temporarily unavailable", never a paywall. Self-service only —
// the mentee triggers it for themselves, and only position/skills strings are
// sent to the provider (no identifiers, no CV).

// GET — availability (the portal card hides itself when no provider is set)
// and the mentee's last prep (#2044), so a reload does not throw it away.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
    const latest = await latestArtifact({ orgId: await settingsOrgOf(session), taskId: 'interview_prep', subjectUserId: session.user.id });
    return NextResponse.json({ configured: isAiConfigured(), latest: latest ? toArtifactDto(latest, session.user.id) : null });
  });
}

const schema = z.object({
  position: z.string().max(120).optional(),
  focus: z.string().max(300).optional(),
  // The explicit Regenerate: skip the stored answer for the same input (#2044).
  regenerate: z.boolean().optional(),
});

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'MENTEE') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const userLimited = enforceRateLimit(request, 'ai:interview_prep', {
    ...AI_RATE_LIMITS.interview_prep,
    subject: session.user.id,
  });
  if (userLimited) return userLimited;

  if (session.user.orgId) {
    const orgLimited = enforceRateLimit(request, 'ai:org', {
      ...AI_RATE_LIMITS.org_burst,
      subject: session.user.orgId,
    });
    if (orgLimited) return orgLimited;
  }

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
      orgId: await settingsOrgOf(session),
      scope: 'interview_prep',
      userId: session.user.id,
      call: () => aiInterviewPrep(position, skills, parsed.data.focus),
      // Kept (#2044): the same position, skills and focus inside the TTL are
      // answered from the stored prep — no provider call, no quota.
      persist: {
        subjectUserId: session.user.id,
        createdById: session.user.id,
        inputHash: hashInput({ position, skills, focus: parsed.data.focus ?? '' }),
        force: parsed.data.regenerate,
      },
    });

    if (!gated.ok) {
      if (gated.reason === 'quota_exceeded') {
        return NextResponse.json({ error: 'Temporarily unavailable', code: 'quota_exceeded' }, { status: 429 });
      }
      // The provider failed even after its retries (#2024): the same neutral
      // "not right now" — never a paywall, never a stack trace.
      if (gated.reason === 'provider_error') {
        return NextResponse.json({ error: 'Temporarily unavailable', code: 'provider_error' }, { status: 503 });
      }
      return NextResponse.json({ error: 'AI is not configured', code: 'not_configured' }, { status: 501 });
    }
    return NextResponse.json({ prep: gated.result, cached: gated.cached ?? false, artifact: gated.artifact ?? null });
  });
}
