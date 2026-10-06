// The server half of the negative-feedback flag (#2046): reads the newest
// open-text summary of each kind for an org, and maps the rows behind its
// negative themes to their relations. The rule is feedbackFlagRule.ts.
//
// Read-time, no table: the flag is derived from artefacts that already exist,
// so it disappears on its own when the next summary no longer finds the
// cluster, when the artefact passes its org's retention, or when an erasure
// wipes the org's open-text artefacts (src/lib/accountErasure.ts).

import { prisma } from '@/lib/prisma';
import { flagsByRelation, negativeThemeRows, type FeedbackFlag } from '@/lib/insights/feedbackFlagRule';
import type { OpenTextSummary } from '@/lib/ai/openTextRules';

/** How old a summary may be and still raise a flag. */
export const FEEDBACK_FLAG_WINDOW_DAYS = 30;

const KINDS = ['evaluation_insights', 'weekly_report_digest'] as const;

export async function negativeFeedbackFlags(orgId: string, now = new Date()): Promise<Map<string, FeedbackFlag>> {
  const since = new Date(now.getTime() - FEEDBACK_FLAG_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const newest = await Promise.all(
    KINDS.map((taskId) =>
      prisma.aiArtifact.findFirst({
        where: { orgId, taskId, subjectUserId: null, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        select: { content: true, createdAt: true, taskId: true },
      }),
    ),
  );
  const summaries: { summary: OpenTextSummary; at: Date; taskId: string }[] = [];
  for (const a of newest) {
    if (!a) continue;
    try {
      const summary = JSON.parse(a.content) as OpenTextSummary;
      if (Array.isArray(summary?.themes)) summaries.push({ summary, at: a.createdAt, taskId: a.taskId });
    } catch {
      // A stored copy that does not decode raises nothing.
    }
  }
  if (summaries.length === 0) return new Map();

  const idsOf = (taskId: string) => summaries.filter((s) => s.taskId === taskId).flatMap((s) => [...negativeThemeRows(s.summary).keys()]);
  const [evaluations, reports] = await Promise.all([
    prisma.evaluation.findMany({ where: { id: { in: idsOf('evaluation_insights') }, relationId: { not: null } }, select: { id: true, relationId: true } }),
    prisma.weeklyReport.findMany({ where: { id: { in: idsOf('weekly_report_digest') }, orgId }, select: { id: true, relationId: true } }),
  ]);
  const relationOf = new Map<string, string>([
    ...evaluations.map((e) => [e.id, e.relationId!] as [string, string]),
    ...reports.map((r) => [r.id, r.relationId] as [string, string]),
  ]);
  return flagsByRelation(summaries, relationOf);
}
