import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { enforceRateLimit } from '@/lib/rateLimit';
import { AI_RATE_LIMITS } from '@/lib/ai/limits';
import { runAiGated } from '@/lib/aiGate';
import { hashInput } from '@/lib/ai/artifacts';
import { practiceReport, practiceTurn } from '@/lib/ai/practiceInterview';
import { practiceContext, toSessionView } from '@/lib/practiceInterview';
import { PRACTICE_ANSWER_MAX, isLastAnswer, readTurns, type PracticeReport } from '@/lib/practiceInterviewRules';

// POST — one typed answer to the current question (#2051). The mentee's own
// session only (anyone else's reads as missing), and only while it runs. The
// answer is fenced as untrusted data in every prompt it enters. Up to the cap
// the reply is the interviewer's observation and next question; the answer
// that reaches the cap ends the session with the after-action report, stored
// as a PRIVATE AiArtifact the mentee may share with their mentor. When the
// provider is unavailable nothing is stored — the answer stays in the box.

const schema = z.object({ answer: z.string().trim().min(1).max(PRACTICE_ANSWER_MAX) }).strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'MENTEE') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const limited = enforceRateLimit(request, 'ai:practice_interview', { ...AI_RATE_LIMITS.practice_interview, subject: session.user.id });
  if (limited) return limited;
  const { id } = await params;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  return await withTenantScope(session, async () => {
    const row = await prisma.practiceSession.findFirst({ where: { id, userId: session.user.id } });
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (row.status !== 'ACTIVE') return NextResponse.json({ error: 'This practice interview is over', code: 'session_over' }, { status: 409 });

    const turns = readTurns(row.turns);
    const current = turns[turns.length - 1];
    if (!current || typeof current.a === 'string') return NextResponse.json({ error: 'No open question', code: 'no_question' }, { status: 409 });
    const answeredTurns = [...turns.slice(0, -1), { ...current, a: parsed.data.answer }];
    const ctx = (await practiceContext(session.user.id, row.requisitionId)) ?? { role: row.role, skills: [], requisitionText: null, requisitionId: null };
    const orgId = await settingsOrgOf(session);

    if (isLastAnswer(answeredTurns, row.maxTurns)) {
      const gated = await runAiGated<PracticeReport | null>({
        orgId,
        scope: 'practice_interview',
        userId: session.user.id,
        call: () => practiceReport(ctx, answeredTurns),
        // PRIVATE by default: the mentee decides whether their mentor reads it.
        persist: {
          subjectUserId: session.user.id,
          createdById: session.user.id,
          requisitionId: row.requisitionId,
          inputHash: hashInput({ practiceSession: row.id }),
          serialize: (r) => JSON.stringify(r),
          deserialize: (c) => JSON.parse(c) as PracticeReport,
        },
      });
      if (!gated.ok || !gated.result) return NextResponse.json({ error: 'Practice interviews are not available right now', code: gated.ok ? 'unavailable' : gated.reason === 'not_configured' ? 'not_configured' : 'unavailable' }, { status: gated.ok || gated.reason !== 'not_configured' ? 503 : 501 });
      const done = await prisma.practiceSession.update({
        where: { id: row.id },
        data: { turns: answeredTurns as unknown as Prisma.InputJsonValue, status: 'COMPLETED', endedAt: new Date(), reportArtifactId: gated.artifact?.id ?? null },
      });
      return NextResponse.json({ session: toSessionView(done), report: gated.result, artifact: gated.artifact ?? null });
    }

    const gated = await runAiGated({ orgId, scope: 'practice_interview', userId: session.user.id, call: () => practiceTurn(ctx, answeredTurns) });
    if (!gated.ok || !gated.result) return NextResponse.json({ error: 'Practice interviews are not available right now', code: gated.ok ? 'unavailable' : gated.reason === 'not_configured' ? 'not_configured' : 'unavailable' }, { status: gated.ok || gated.reason !== 'not_configured' ? 503 : 501 });
    const next = [...answeredTurns.slice(0, -1), { ...answeredTurns[answeredTurns.length - 1], note: gated.result.observation }, { q: gated.result.question }];
    const updated = await prisma.practiceSession.update({ where: { id: row.id }, data: { turns: next as unknown as Prisma.InputJsonValue } });
    return NextResponse.json({ session: toSessionView(updated) });
  });
}
