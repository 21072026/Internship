import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getThreadIfAllowed } from '@/lib/messaging';
import { runAiGated } from '@/lib/aiGate';
import { aiSummarizeInteractions } from '@/lib/aiSummary';

const schema = z.object({ relationId: z.string().min(1) });

// POST — AI auto-summary of a relation's interaction logs (Faz 2, #534).
// Mentor/admin only (it is a mentor-facing digest of their own log). Runs
// through the central AI gate: the MENTEE's AI_INTERACTION_SUMMARY consent →
// monthly quota → provider. Only log text is sent, never files/contact data.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  const rel = await getThreadIfAllowed(session.user, parsed.data.relationId);
  if (!rel) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const interactions = await prisma.interactionLog.findMany({
    where: { relationId: rel.id },
    orderBy: { date: 'desc' },
    take: 30,
    select: { date: true, type: true, subject: true, notes: true },
  });
  if (interactions.length === 0) return NextResponse.json({ summary: null, empty: true });

  const gated = await runAiGated({
    scope: 'interaction_summary',
    // The mentee's data is being processed — their consent gates the call.
    consent: { userId: rel.menteeId, type: 'AI_INTERACTION_SUMMARY' },
    userId: session.user.id,
    call: () => aiSummarizeInteractions(rel.mentee.fullName, interactions),
  });

  if (!gated.ok) {
    if (gated.reason === 'no_consent') {
      return NextResponse.json({ error: 'Mentee consent required', code: 'consent_required' }, { status: 403 });
    }
    if (gated.reason === 'quota_exceeded') {
      return NextResponse.json({ error: 'Monthly AI quota exhausted', code: 'quota_exceeded' }, { status: 429 });
    }
    return NextResponse.json({ error: 'AI is not configured', code: 'not_configured' }, { status: 501 });
  }
  return NextResponse.json({ summary: gated.result });
}
