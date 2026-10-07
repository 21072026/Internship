import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { enforceRateLimit } from '@/lib/rateLimit';
import { AI_RATE_LIMITS } from '@/lib/ai/limits';
import { runAiGated } from '@/lib/aiGate';
import { hashInput } from '@/lib/ai/artifacts';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { getLocale } from '@/i18n/server';
import { aiCatchUp } from '@/lib/aiThread';
import { loadThreadAiContext } from '@/lib/threadAiContext';
import { threadAiRefusal } from '@/lib/threadAiResponses';

// POST — "what happened here" for one conversation (#2048). Participants only
// (src/lib/threadAiContext.ts), consent-gated on everyone quoted, free — no
// plan or entitlement check, messaging is free for mentors and mentees — and
// kept as an AiArtifact keyed on the thread's last message and last edit, so
// opening the same thread again answers from the stored summary with no
// provider call and no quota. `regenerate` asks for a fresh one.

const schema = z.object({ regenerate: z.boolean().optional() }).strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, () => handlePost(request, params));
}

async function handlePost(request: Request, params: Promise<{ id: string }>) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const limited = enforceRateLimit(request, 'ai:thread_summary', { ...AI_RATE_LIMITS.thread_summary, subject: session.user.id });
  if (limited) return limited;
  if (session.user.orgId) {
    const orgLimited = enforceRateLimit(request, 'ai:org', { ...AI_RATE_LIMITS.org_burst, subject: session.user.orgId });
    if (orgLimited) return orgLimited;
  }
  const { id } = await params;
  const parsed = schema.safeParse((await request.json().catch(() => ({}))) ?? {});
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  return await withTenantScope(session, async () => {
    const load = await loadThreadAiContext(session.user, id);
    if (!load.ok) {
      if (load.reason === 'empty') return NextResponse.json({ summary: null, empty: true });
      return threadAiRefusal(load.reason);
    }
    const { ctx } = load;
    const me = await prisma.user.findUnique({ where: { id: session.user.id }, select: { preferredLanguage: true } });
    const locale = me?.preferredLanguage ?? (await getLocale());

    const gated = await runAiGated({
      orgId: await settingsOrgOf(session),
      scope: 'thread_summary',
      ...(ctx.quotedUserIds[0] ? { consent: { userId: ctx.quotedUserIds[0], type: 'AI_INTERACTION_SUMMARY' as const } } : {}),
      userId: session.user.id,
      call: () => aiCatchUp({ transcript: ctx.transcript, readerName: ctx.readerName, locale }),
      // Subject-less: a catch-up quotes every participant, so erasing any of
      // them wipes it (OPEN_TEXT_TASKS). The asker is in the key, so one
      // participant never reads another's copy.
      persist: {
        subjectUserId: null,
        createdById: session.user.id,
        inputHash: hashInput({ conversationId: ctx.conversationId, reader: session.user.id, last: ctx.lastMessageId, edited: ctx.lastEditedAt, locale }),
        force: parsed.data.regenerate,
      },
    });
    if (!gated.ok) return threadAiRefusal(gated.reason);
    return NextResponse.json({ summary: gated.result, cached: !!gated.cached, artifact: gated.artifact ?? null });
  });
}
