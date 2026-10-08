import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { enforceRateLimit } from '@/lib/rateLimit';
import { AI_RATE_LIMITS } from '@/lib/ai/limits';
import { runAiGated } from '@/lib/aiGate';
import { isAiConfigured } from '@/lib/ai/provider';
import { practiceTurn } from '@/lib/ai/practiceInterview';
import { practiceContext, toSessionView } from '@/lib/practiceInterview';
import { tailorableRoles } from '@/lib/cvReview';
import { PRACTICE_MAX_TURNS } from '@/lib/practiceInterviewRules';
import { toArtifactDto } from '@/lib/ai/artifacts';

// A text-only practice interview (#2051) — the mentee's own, MENTEE only, and
// FREE: every denial (provider off, quota, failure) is the same neutral "not
// available right now"; the mentee never sees a budget, a plan or an upgrade.
// No audio, no video, no recording anywhere in this feature.

// GET — the card's state: whether it can run, the roles the mentee may practise
// for, the session in progress and the last finished ones with their reports.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'MENTEE') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  return await withTenantScope(session, async () => {
    const [me, roles, sessions] = await Promise.all([
      prisma.user.findUnique({ where: { id: session.user.id }, select: { targetPosition: true } }),
      tailorableRoles(session.user.id),
      prisma.practiceSession.findMany({ where: { userId: session.user.id }, orderBy: { startedAt: 'desc' }, take: 4 }),
    ]);
    const reportIds = sessions.map((s) => s.reportArtifactId).filter((x): x is string => !!x);
    const reports = reportIds.length
      ? await prisma.aiArtifact.findMany({ where: { id: { in: reportIds }, subjectUserId: session.user.id } })
      : [];
    const byId = new Map(reports.map((r) => [r.id, toArtifactDto(r, session.user.id)]));
    return NextResponse.json({
      configured: isAiConfigured(),
      targetPosition: me?.targetPosition ?? null,
      roles,
      active: sessions.find((s) => s.status === 'ACTIVE') ? toSessionView(sessions.find((s) => s.status === 'ACTIVE')!) : null,
      finished: sessions.filter((s) => s.status === 'COMPLETED').map((s) => ({ ...toSessionView(s), report: s.reportArtifactId ? byId.get(s.reportArtifactId) ?? null : null })),
    });
  });
}

const schema = z.object({ requisitionId: z.string().min(1).optional() }).strict();

// POST — start a session: the interviewer's opening question. A session in
// progress is returned as it is rather than started twice.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'MENTEE') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const limited = enforceRateLimit(request, 'ai:practice_interview', { ...AI_RATE_LIMITS.practice_interview, subject: session.user.id });
  if (limited) return limited;
  const parsed = schema.safeParse((await request.json().catch(() => ({}))) ?? {});
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  return await withTenantScope(session, async () => {
    const active = await prisma.practiceSession.findFirst({ where: { userId: session.user.id, status: 'ACTIVE' }, orderBy: { startedAt: 'desc' } });
    if (active) return NextResponse.json({ session: toSessionView(active), resumed: true });

    const ctx = await practiceContext(session.user.id, parsed.data.requisitionId ?? null);
    if (!ctx) return NextResponse.json({ error: 'Choose a role first', code: parsed.data.requisitionId ? 'role_not_found' : 'no_position' }, { status: parsed.data.requisitionId ? 404 : 400 });

    const orgId = await settingsOrgOf(session);
    const gated = await runAiGated({ orgId, scope: 'practice_interview', userId: session.user.id, call: () => practiceTurn(ctx, []) });
    if (!gated.ok || !gated.result) return unavailable(gated.ok ? 'provider_error' : gated.reason);

    const created = await prisma.practiceSession.create({
      data: { orgId, userId: session.user.id, requisitionId: ctx.requisitionId, role: ctx.role.slice(0, 191), maxTurns: PRACTICE_MAX_TURNS, turns: [{ q: gated.result.question }] },
    });
    return NextResponse.json({ session: toSessionView(created) }, { status: 201 });
  });
}

/** The one answer every denial gets — never a paywall, never a quota. */
function unavailable(reason: string) {
  // Switched off by the organisation (#2032) is the one denial named as such.
  if (reason === 'disabled') return NextResponse.json({ error: 'AI is turned off for this organisation', code: 'disabled' }, { status: 403 });
  return NextResponse.json({ error: 'Practice interviews are not available right now', code: reason === 'not_configured' ? 'not_configured' : 'unavailable' }, { status: reason === 'not_configured' ? 501 : 503 });
}
