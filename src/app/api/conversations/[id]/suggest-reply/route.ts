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
import { aiSuggestReply } from '@/lib/aiThread';
import { loadThreadAiContext } from '@/lib/threadAiContext';
import { threadAiRefusal } from '@/lib/threadAiResponses';
import { REPLY_TONES, replyLocale } from '@/lib/threadAiRules';

// POST — a suggested reply for the caller to EDIT (#2048). It returns text and
// nothing else: no message is created here, and the composer only fills its
// box with it — a person pressing Send is the one way it becomes a message.
// Written in the recipient's language on a 1:1 thread (the author's own in a
// group room), in one of three tones. Same gate and consent as the catch-up,
// cached per tone on the thread's last message. Free, never plan-gated.

const schema = z.object({ tone: z.enum(REPLY_TONES), regenerate: z.boolean().optional() }).strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, () => handlePost(request, params));
}

async function handlePost(request: Request, params: Promise<{ id: string }>) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const limited = enforceRateLimit(request, 'ai:suggested_reply', { ...AI_RATE_LIMITS.suggested_reply, subject: session.user.id });
  if (limited) return limited;
  if (session.user.orgId) {
    const orgLimited = enforceRateLimit(request, 'ai:org', { ...AI_RATE_LIMITS.org_burst, subject: session.user.orgId });
    if (orgLimited) return orgLimited;
  }
  const { id } = await params;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  return await withTenantScope(session, async () => {
    const load = await loadThreadAiContext(session.user, id);
    if (!load.ok) {
      if (load.reason === 'empty') return NextResponse.json({ draft: null, empty: true });
      return threadAiRefusal(load.reason);
    }
    const { ctx } = load;
    const me = await prisma.user.findUnique({ where: { id: session.user.id }, select: { preferredLanguage: true } });
    const locale = replyLocale(ctx.others, me?.preferredLanguage ?? (await getLocale()));
    const tone = parsed.data.tone;
    const recipientName = ctx.others.length === 1 ? ctx.others[0].fullName : ctx.others.map((o) => o.fullName).join(', ');

    const gated = await runAiGated({
      orgId: await settingsOrgOf(session),
      scope: 'suggested_reply',
      ...(ctx.quotedUserIds[0] ? { consent: { userId: ctx.quotedUserIds[0], type: 'AI_INTERACTION_SUMMARY' as const } } : {}),
      userId: session.user.id,
      call: () => aiSuggestReply({ transcript: ctx.transcript, authorName: ctx.readerName, recipientName, locale, tone }),
      persist: {
        subjectUserId: null,
        createdById: session.user.id,
        inputHash: hashInput({ conversationId: ctx.conversationId, author: session.user.id, last: ctx.lastMessageId, edited: ctx.lastEditedAt, locale, tone }),
        force: parsed.data.regenerate,
      },
    });
    if (!gated.ok) return threadAiRefusal(gated.reason);
    return NextResponse.json({ draft: gated.result, locale, tone, cached: !!gated.cached });
  });
}
