import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { resolveOrgId } from '@/lib/orgScope';
import { inCallerTenant } from '@/lib/tenantFilter';
import { enforceRateLimit } from '@/lib/rateLimit';
import { AI_RATE_LIMITS } from '@/lib/ai/limits';
import { runAiGated } from '@/lib/aiGate';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { hashInput } from '@/lib/ai/artifacts';
import { locales, type Locale } from '@/i18n/config';
import { aiNextStepSuggestions } from '@/lib/aiNextStep';
import { resolvePipelineStages, stageLabel } from '@/lib/pipelineStages';
import { daysInStage } from '@/lib/stageClock';
import { threadAiRefusal } from '@/lib/threadAiResponses';

// POST — three AI-proposed next steps for the follow-up field of one record
// (#2875). The owner of the pair (or an admin of its org) only; the MENTEE's
// AI_INTERACTION_SUMMARY consent gates it, because the input is their
// interaction log — the same text the summary task reads. Written in the
// CALLER's language: the note is the owner's own line, not a message.
//
// It returns text and nothing else: no note is saved here, the panel shows
// the three lines as chips and the owner clicks one into the field and
// presses Save. An unchanged log + stage + note is answered from the stored
// copy (1-day TTL) with no provider call and no quota; `regenerate` asks again.

const schema = z.object({ regenerate: z.boolean().optional() }).strict();

const LOG_ENTRIES = 10;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, () => handlePost(request, params));
}

async function handlePost(request: Request, params: Promise<{ id: string }>) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const limited = enforceRateLimit(request, 'ai:next_step_suggest', { ...AI_RATE_LIMITS.next_step_suggest, subject: session.user.id });
  if (limited) return limited;
  if (session.user.orgId) {
    const orgLimited = enforceRateLimit(request, 'ai:org', { ...AI_RATE_LIMITS.org_burst, subject: session.user.orgId });
    if (orgLimited) return orgLimited;
  }
  const { id } = await params;
  const parsed = schema.safeParse((await request.json().catch(() => ({}))) ?? {});
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  return await withTenantScope(session, async () => {
    const rel = await prisma.mentorshipRelation.findUnique({
      where: { id },
      select: {
        id: true,
        orgId: true,
        mentorId: true,
        menteeId: true,
        pipelineStatus: true,
        startDate: true,
        nextActionNote: true,
        statusChanges: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true, fromStatus: true, toStatus: true } },
      },
    });
    // The owner of the pair, or an admin of its org; anything else reads as missing.
    const allowed = rel && (session.user.role === 'ADMIN' ? await inCallerTenant(rel.orgId, resolveOrgId(session)) : rel.mentorId === session.user.id);
    if (!rel || !allowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const interactions = await prisma.interactionLog.findMany({
      where: { relationId: rel.id },
      orderBy: { date: 'desc' },
      take: LOG_ENTRIES,
      select: { date: true, type: true, subject: true, notes: true },
    });
    // Without a single log entry the model would only restate the stage —
    // which the built-in chips already do for free.
    if (interactions.length === 0) return NextResponse.json({ suggestions: [], empty: true });

    const caller = await prisma.user.findUnique({ where: { id: session.user.id }, select: { preferredLanguage: true } });
    const locale: Locale = (locales as readonly string[]).includes(caller?.preferredLanguage ?? '') ? (caller!.preferredLanguage as Locale) : 'en';
    const stages = await resolvePipelineStages(rel.orgId, locale);
    const input = {
      stageKey: rel.pipelineStatus,
      stageLabel: stageLabel(stages, rel.pipelineStatus, locale),
      daysInStage: daysInStage(rel),
      locale,
      currentNote: rel.nextActionNote,
      interactions,
    };

    const gated = await runAiGated<string[]>({
      orgId: await settingsOrgOf(session),
      scope: 'next_step_suggest',
      consent: { userId: rel.menteeId, type: 'AI_INTERACTION_SUMMARY' },
      userId: session.user.id,
      call: () => aiNextStepSuggestions(input),
      persist: {
        subjectUserId: rel.menteeId,
        createdById: session.user.id,
        relationId: rel.id,
        // The day is part of the key on purpose: "days in stage" moves every
        // midnight, and a record that sat another week deserves a fresh answer.
        inputHash: hashInput({
          relationId: rel.id,
          stage: rel.pipelineStatus,
          daysInStage: input.daysInStage,
          locale,
          note: rel.nextActionNote ?? '',
          log: interactions.map((i) => ({ date: i.date.toISOString(), type: i.type, subject: i.subject ?? '', notes: i.notes })),
        }),
        force: parsed.data.regenerate,
        serialize: (s) => JSON.stringify(s),
        deserialize: (c) => {
          const v = JSON.parse(c) as unknown;
          if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new Error('not a suggestion list');
          return v as string[];
        },
      },
    });
    if (!gated.ok) return threadAiRefusal(gated.reason);
    return NextResponse.json({ suggestions: gated.result, cached: !!gated.cached });
  });
}
