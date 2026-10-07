// The scored CV review's server reads (#2050): which roles a mentee may tailor
// against, the tailoring target itself, and the previous score for the delta.
// Server-only; the rules are src/lib/cvReviewRules.ts.

import { prisma } from '@/lib/prisma';
import { missingRequiredSkills, readStoredFeedback } from '@/lib/cvReviewRules';
import type { TailoringTarget } from '@/lib/aiCvFeedback';

const LIVE = { notIn: ['DRAFT', 'CANCELLED'] };

/**
 * The roles a mentee may tailor their CV to: requisitions they are already
 * connected to — a company registered (and kept) interest in them for it, or asked to
 * interview them for it. Never the org's whole requisition list: what a
 * company is hiring for is not every mentee's to browse.
 */
export async function tailorableRoles(menteeId: string): Promise<{ id: string; title: string; company: string }[]> {
  const rows = await prisma.requisition.findMany({
    where: {
      status: LIVE,
      OR: [{ interests: { some: { menteeId, status: { not: 'PASS' } } } }, { interviewRequests: { some: { menteeId } } }],
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, title: true, company: { select: { name: true } } },
  });
  return rows.map((r) => ({ id: r.id, title: r.title, company: r.company.name }));
}

/** The requisition as a tailoring target, if this mentee may use it; null otherwise. */
export async function tailoringTarget(menteeId: string, requisitionId: string, cvText: string): Promise<TailoringTarget | null> {
  const r = await prisma.requisition.findFirst({
    where: {
      id: requisitionId,
      status: LIVE,
      OR: [{ interests: { some: { menteeId, status: { not: 'PASS' } } } }, { interviewRequests: { some: { menteeId } } }],
    },
    select: { id: true, title: true, description: true, requiredSkills: true },
  });
  if (!r) return null;
  const requiredSkills = (Array.isArray(r.requiredSkills) ? r.requiredSkills : []).filter((s): s is string => typeof s === 'string');
  return { id: r.id, title: r.title, description: r.description, requiredSkills, deterministicMissing: missingRequiredSkills(requiredSkills, cvText) };
}

/** The score of the scored review before `before`, for the same target (general or one requisition). One query. */
export async function previousScore(input: { orgId: string; subjectUserId: string; requisitionId: string | null; before: Date }): Promise<number | null> {
  const rows = await prisma.aiArtifact.findMany({
    where: { orgId: input.orgId, taskId: 'cv_feedback', subjectUserId: input.subjectUserId, requisitionId: input.requisitionId, createdAt: { lt: input.before } },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { content: true },
  });
  for (const r of rows) {
    const stored = readStoredFeedback(r.content);
    if (stored.kind === 'review') return stored.review.score;
  }
  return null;
}
