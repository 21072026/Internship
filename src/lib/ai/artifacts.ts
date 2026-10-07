// AI artefacts (#2044), server-only: what an AI call produced, kept so a result
// survives a reload, can be shared, and an identical request inside its TTL is
// answered without a provider call or a unit of quota. Written by runAiGated's
// `persist` option (src/lib/aiGate.ts); read and shared through this file.
//
// WHO READS AN ARTEFACT — decided here, never in a component:
//   • its subject (the person it is about) and its creator, always;
//   • the subject's ACTIVE mentor, when the subject shared it with them;
//   • an ADMIN of the org, when it was shared (with the mentor or the admin);
//   • nobody across an org line.
// Only the subject changes visibility: it is their data, their call to share.

import { createHash } from 'crypto';
import type { AiArtifact } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getRetentionMonths } from '@/lib/retention';
import { inCallerTenant } from '@/lib/tenantFilter';
import type { AiTaskId } from '@/lib/ai/tasks';

export const ARTIFACT_VISIBILITIES = ['PRIVATE', 'SHARED_WITH_MENTOR', 'SHARED_WITH_ADMIN'] as const;
export type ArtifactVisibility = (typeof ARTIFACT_VISIBILITIES)[number];

const DAY = 24 * 60 * 60 * 1000;

/**
 * How long an artefact answers an identical request instead of the provider.
 * Advice about a person's own CV or target role does not go stale in an hour;
 * a summary of a live relation does. A task missing here is never cached.
 */
export const TASK_TTL_MS: Record<string, number> = {
  cv_feedback: 7 * DAY,
  interview_prep: 7 * DAY,
  // Open-text insights (#2046): keyed on exactly the rows sent, so any new or
  // edited row is a fresh question anyway; the day bounds how long a page
  // view keeps re-reading one answer.
  evaluation_insights: 1 * DAY,
  weekly_report_digest: 1 * DAY,
  survey_summary: 1 * DAY,
  // Keyed on the dashboard figures: a new interaction is a new paragraph.
  analytics_narrative: 1 * DAY,
  interaction_summary: 1 * DAY,
  mentor_match: 1 * DAY,
};

/**
 * Tasks whose artefacts quote MANY people at once and have no subject (#2046):
 * a summary of an org's evaluation comments or weekly-report blockers. Erasing
 * any one of those people wipes the org's copies (src/lib/accountErasure.ts) —
 * they are a cache, regenerated on the next request, and a quote of an erased
 * person must not outlive them.
 */
export const OPEN_TEXT_TASKS = ['evaluation_insights', 'weekly_report_digest', 'survey_summary'] as const satisfies readonly AiTaskId[];

/** sha256 over a stable JSON rendering — key order never changes the hash. */
export function hashInput(value: unknown): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]))
        : v;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

/** An artefact of this task and input, younger than the task's TTL, or null. */
export async function findCachedArtifact(input: { orgId: string | null; taskId: string; subjectUserId: string | null; inputHash: string; now?: Date }): Promise<AiArtifact | null> {
  const ttl = TASK_TTL_MS[input.taskId];
  if (!ttl) return null;
  const now = input.now ?? new Date();
  return prisma.aiArtifact.findFirst({
    where: {
      orgId: input.orgId,
      taskId: input.taskId,
      subjectUserId: input.subjectUserId,
      inputHash: input.inputHash,
      createdAt: { gte: new Date(now.getTime() - ttl) },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export interface ArtifactViewer {
  id: string;
  role: string;
  orgId?: string | null;
}

export async function canReadArtifact(viewer: ArtifactViewer, a: Pick<AiArtifact, 'orgId' | 'subjectUserId' | 'createdById' | 'visibility'>): Promise<boolean> {
  if (!(await inCallerTenant(a.orgId, viewer.orgId ?? null))) return false;
  if (viewer.id === a.subjectUserId || viewer.id === a.createdById) return true;
  if (a.visibility === 'PRIVATE' || !a.subjectUserId) return false;
  if (viewer.role === 'ADMIN') return true;
  if (viewer.role === 'MENTOR' && a.visibility === 'SHARED_WITH_MENTOR') {
    const rel = await prisma.mentorshipRelation.findFirst({
      where: { mentorId: viewer.id, menteeId: a.subjectUserId, status: 'ACTIVE' },
      select: { id: true },
    });
    return !!rel;
  }
  return false;
}

export interface ArtifactDto {
  id: string;
  taskId: string;
  content: string;
  visibility: string;
  createdAt: string;
  mine: boolean;
}

export function toArtifactDto(a: AiArtifact, viewerId: string): ArtifactDto {
  return { id: a.id, taskId: a.taskId, content: a.content, visibility: a.visibility, createdAt: a.createdAt.toISOString(), mine: a.subjectUserId === viewerId };
}

/**
 * Retention (#2044): an artefact older than its org's `retentionMonths` is
 * deleted — generated text about a person is not kept longer than the person's
 * own records are reviewed for. Pinned ones are no exception; a pin keeps an
 * artefact at the top of a list, not past the retention promise.
 */
export async function sweepAiArtifacts(now = new Date()): Promise<{ deleted: number }> {
  const orgs = await prisma.aiArtifact.findMany({ distinct: ['orgId'], select: { orgId: true } });
  let deleted = 0;
  for (const { orgId } of orgs) {
    const months = await getRetentionMonths(orgId ?? undefined);
    const cutoff = new Date(now);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
    const r = await prisma.aiArtifact.deleteMany({ where: { orgId, createdAt: { lt: cutoff } } });
    deleted += r.count;
  }
  return { deleted };
}

/**
 * The newest artefact of a task about this person, in this org — what a card
 * shows on mount. `relationId` narrows it to one pairing: a summary of the
 * interaction log belongs to the relation whose log it read, so a mentor who
 * took the mentee over does not open on the previous pairing's digest.
 */
export async function latestArtifact(input: { orgId: string | null; taskId: string; subjectUserId: string; relationId?: string }): Promise<AiArtifact | null> {
  return prisma.aiArtifact.findFirst({
    where: { orgId: input.orgId, taskId: input.taskId, subjectUserId: input.subjectUserId, ...(input.relationId ? { relationId: input.relationId } : {}) },
    orderBy: { createdAt: 'desc' },
  });
}
