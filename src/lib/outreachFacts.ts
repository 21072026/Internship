// The facts a grounded outreach draft may use (#2048, part 2), read for ONE
// relation and ONE viewer. Server-only. What goes in is deliberately narrow —
// see factsBlock() in src/lib/outreachRules.ts — and goals pass through the
// same visibility rule their own screens use, so a mentee's PRIVATE goal can
// never end up quoted in the mentor's draft.

import { prisma } from '@/lib/prisma';
import type { Locale } from '@/i18n/config';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { stageLabel } from '@/lib/pipeline';
import { outcomeForStage } from '@/lib/outcomeComms';
import { visibleGoals, type GoalViewer } from '@/lib/goalVisibilityRule';
import { directKeyFor } from '@/lib/conversations';
import { hashInput } from '@/lib/ai/artifacts';
import { factsBlock, firstName, type OutreachFacts } from '@/lib/outreachRules';

export interface OutreachRelation {
  id: string;
  orgId: string | null;
  mentorId: string;
  menteeId: string;
  pipelineStatus: string;
  dormantSince: Date | null;
  mentee: { fullName: string; preferredLanguage: string | null };
}

export async function loadOutreachFacts(rel: OutreachRelation, viewer: GoalViewer, locale: Locale): Promise<OutreachFacts> {
  const now = new Date();
  const stages = await resolvePipelineStages(rel.orgId, locale);
  const current = stages.find((s) => s.key === rel.pipelineStatus);
  const conversation = await prisma.conversation.findUnique({
    where: { directKey: directKeyFor(rel.mentorId, rel.menteeId) },
    select: { id: true },
  });
  const thread = conversation ? { OR: [{ relationId: rel.id }, { conversationId: conversation.id }] } : { relationId: rel.id };

  const [goals, lastMeeting, lastMessage, mentorMessage, interaction] = await Promise.all([
    prisma.goal.findMany({
      where: { relationId: rel.id, status: 'OPEN' },
      orderBy: { createdAt: 'asc' },
      take: 20,
      select: { title: true, visibility: true, createdById: true, createdByRole: true },
    }),
    prisma.meeting.findFirst({ where: { relationId: rel.id, scheduledAt: { lte: now } }, orderBy: { scheduledAt: 'desc' }, select: { scheduledAt: true } }),
    prisma.message.findFirst({ where: { ...thread, deletedForEveryoneAt: null }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    prisma.message.findFirst({ where: { ...thread, senderId: { not: rel.menteeId } }, select: { id: true } }),
    prisma.interactionLog.findFirst({ where: { relationId: rel.id }, select: { id: true } }),
  ]);

  return {
    menteeFirstName: firstName(rel.mentee.fullName),
    stageLabel: stageLabel(stages, rel.pipelineStatus, locale),
    firstStage: stages.length > 0 && stages[0].key === rel.pipelineStatus,
    dormant: rel.dormantSince !== null,
    outcome: outcomeForStage(rel.pipelineStatus, { isOffPath: current?.isOffPath }),
    openGoals: visibleGoals(goals, { mentorId: rel.mentorId, menteeId: rel.menteeId }, viewer).map((g) => g.title),
    lastMeetingAt: lastMeeting?.scheduledAt?.toISOString() ?? null,
    lastMessageAt: lastMessage?.createdAt.toISOString() ?? null,
    mentorHasWritten: Boolean(mentorMessage || interaction),
  };
}

/** The stored draft's key: the facts as sent, the moment, the language and the author. */
export function outreachDraftHash(relationId: string, author: string, moment: string, locale: string, facts: OutreachFacts): string {
  return hashInput({ relationId, author, moment, locale, facts: factsBlock(facts) });
}
