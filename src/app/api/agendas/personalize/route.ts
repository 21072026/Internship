import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { enforceRateLimit } from '@/lib/rateLimit';
import { AI_RATE_LIMITS } from '@/lib/ai/limits';
import { runAiGated } from '@/lib/aiGate';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { hashInput } from '@/lib/ai/artifacts';
import { locales, type Locale } from '@/i18n/config';
import { INACTIVE_RELATION_ERROR, menteeWriteClosed } from '@/lib/menteeRelation';
import { agendaIfAllowed, viewerOf } from '@/lib/agendaAccess';
import { resolveItemText, resolveTemplateText } from '@/lib/agendasRule';
import { resolvePipelineStages, stageLabel } from '@/lib/pipelineStages';
import { aiProposeAgenda } from '@/lib/aiAgenda';
import { AGENDA_LOG_ENTRIES, agendaGoalsFor, agendaHasContext, templateFallback, type AgendaPayloadInput } from '@/lib/aiAgendaRule';
import { threadAiRefusal } from '@/lib/threadAiResponses';

// POST — a personalised proposal for one session agenda (#1845): 4-7 lines
// adapted from the guide, the pair's open goals, the previous session and
// the newest log entries, in the CALLER's language. Either seat of the pair
// (or an admin of its org) may ask; the MENTEE's AI_INTERACTION_SUMMARY
// consent gates it, because the log is part of what goes out.
//
// It returns text and nothing else: the panel shows the lines as a draft and
// a seat adds the ones that fit through POST /api/agendas/[id]/items. Every
// denial degrades honestly — the guide's prompts that are not on the agenda
// yet, with the reason — never a paywall, never an error page (participant
// AI is free, #1738; an ADMIN on a pair that is not theirs is operator use
// and the one caller the pack may lock). An unchanged agenda, guide, goal
// set, previous session and log is answered from the stored copy (1-day TTL)
// with no provider call and no quota; `regenerate` asks again.

const schema = z
  .object({
    agendaId: z.string().min(1),
    /** The guide to adapt when the agenda is free-form; ignored when the agenda has its own. */
    templateId: z.string().min(1).optional(),
    regenerate: z.boolean().optional(),
  })
  .strict();

export async function POST(request: Request) {
  return withRequestScope(request, () => handlePost(request));
}

async function handlePost(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const limited = enforceRateLimit(request, 'ai:agenda_personalize', { ...AI_RATE_LIMITS.agenda_personalize, subject: session.user.id });
  if (limited) return limited;
  if (session.user.orgId) {
    const orgLimited = enforceRateLimit(request, 'ai:org', { ...AI_RATE_LIMITS.org_burst, subject: session.user.orgId });
    if (orgLimited) return orgLimited;
  }
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  return await withTenantScope(session, async () => {
    const agenda = await agendaIfAllowed(session, parsed.data.agendaId);
    if (agenda === 'missing') return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!agenda) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const rel = agenda.relation;
    // A proposal for a pairing that has ended would be refused on acceptance anyway.
    if (menteeWriteClosed(rel, session.user.id)) return NextResponse.json(INACTIVE_RELATION_ERROR, { status: 409 });

    const caller = await prisma.user.findUnique({ where: { id: session.user.id }, select: { preferredLanguage: true } });
    const locale: Locale = (locales as readonly string[]).includes(caller?.preferredLanguage ?? '') ? (caller!.preferredLanguage as Locale) : 'en';
    const viewer = viewerOf(session);

    // The guide: the agenda's own, or — for a free-form agenda — the one the
    // caller names, under the same tenant and archive rule as /api/agendas.
    let guide: AgendaPayloadInput['guide'] = null;
    let guideId: string | null = null;
    if (agenda.templateId && agenda.template) {
      const items = await prisma.agendaTemplateItem.findMany({ where: { templateId: agenda.templateId }, orderBy: { order: 'asc' }, select: { prompt: true, translations: true } });
      guide = {
        title: resolveTemplateText({ text: agenda.template.title, translations: agenda.template.translations }, locale),
        prompts: items.map((i) => resolveTemplateText({ text: i.prompt, translations: i.translations }, locale)),
      };
      guideId = agenda.templateId;
    } else if (parsed.data.templateId) {
      const template = await prisma.agendaTemplate.findUnique({
        where: { id: parsed.data.templateId },
        select: { id: true, orgId: true, archivedAt: true, title: true, translations: true, items: { orderBy: { order: 'asc' }, select: { prompt: true, translations: true } } },
      });
      if (!template || template.archivedAt || (template.orgId !== null && template.orgId !== rel.orgId && rel.orgId !== null)) {
        return NextResponse.json({ error: 'Template not found' }, { status: 404 });
      }
      guide = {
        title: resolveTemplateText({ text: template.title, translations: template.translations }, locale),
        prompts: template.items.map((i) => resolveTemplateText({ text: i.prompt, translations: i.translations }, locale)),
      };
      guideId = template.id;
    }

    const existingLines = agenda.items.map((item) => resolveItemText(item, locale));

    const [previous, goalRows, log, stageRow] = await Promise.all([
      prisma.sessionAgenda.findFirst({
        where: { relationId: rel.id, id: { not: agenda.id }, createdAt: { lte: agenda.createdAt } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, items: { orderBy: { order: 'asc' }, select: { id: true, text: true, done: true, templateItem: { select: { prompt: true, translations: true } } } } },
      }),
      prisma.goal.findMany({
        where: { relationId: rel.id, status: 'OPEN' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, title: true, successCriteria: true, progress: true, visibility: true, createdById: true, createdByRole: true },
      }),
      prisma.interactionLog.findMany({
        where: { relationId: rel.id },
        orderBy: { date: 'desc' },
        take: AGENDA_LOG_ENTRIES,
        select: { id: true, date: true, type: true, subject: true, notes: true },
      }),
      prisma.mentorshipRelation.findUnique({ where: { id: rel.id }, select: { pipelineStatus: true } }),
    ]);
    const previousLines = (previous?.items ?? []).map((item) => ({ text: resolveItemText(item, locale), done: item.done }));
    const stages = await resolvePipelineStages(rel.orgId, locale);
    const input: AgendaPayloadInput = {
      locale,
      stageLabel: stageRow ? stageLabel(stages, stageRow.pipelineStatus, locale) : '',
      guide,
      existingLines,
      previousLines,
      goals: goalRows,
      log,
      rel,
      viewer,
    };
    // Nothing specific to adapt to: the built-in guides already say what is
    // usually next, and a call would only restate them.
    if (!agendaHasContext(input)) return NextResponse.json({ proposals: [], source: 'empty', empty: true });

    const gated = await runAiGated<string[]>({
      orgId: await settingsOrgOf(session),
      scope: 'agenda_personalize',
      // The pair's own agenda is the free core; an ADMIN who is neither seat
      // is using it as a tool, which is operator use (#1738).
      ...(session.user.role === 'ADMIN' && rel.mentorId !== session.user.id && rel.menteeId !== session.user.id ? { audience: 'operator' as const } : {}),
      consent: { userId: rel.menteeId, type: 'AI_INTERACTION_SUMMARY' },
      userId: session.user.id,
      call: () => aiProposeAgenda(input),
      persist: {
        subjectUserId: rel.menteeId,
        createdById: session.user.id,
        relationId: rel.id,
        // Keyed on what goes out — the goals THIS viewer may read included,
        // so a seat never reads a proposal built from a goal hidden from them.
        inputHash: hashInput({
          agendaId: agenda.id,
          guideId,
          existingLines,
          goals: agendaGoalsFor(goalRows, rel, viewer).map((g) => ({ id: g.id, title: g.title, criteria: g.successCriteria ?? '', progress: g.progress })),
          previous: previous ? { id: previous.id, items: previous.items.map((i) => ({ id: i.id, done: i.done })) } : null,
          log: log.map((e) => e.id),
          stage: stageRow?.pipelineStatus ?? '',
          locale,
        }),
        force: parsed.data.regenerate,
        serialize: (lines) => JSON.stringify(lines),
        deserialize: (content) => {
          const value = JSON.parse(content) as unknown;
          if (!Array.isArray(value) || !value.every((x) => typeof x === 'string')) throw new Error('not a proposal');
          return value as string[];
        },
      },
    });
    if (!gated.ok) {
      // Only an escalated admin can reach this one (the pack); every other
      // denial is the guide as written, with the reason.
      if (gated.reason === 'not_entitled') return threadAiRefusal(gated.reason);
      return NextResponse.json({ proposals: templateFallback(guide?.prompts ?? [], existingLines), source: 'template', reason: gated.reason });
    }
    return NextResponse.json({ proposals: gated.result, source: 'ai', cached: !!gated.cached });
  });
}
