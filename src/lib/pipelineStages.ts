// Per-tenant pipeline-stage resolution (#747, part of white-label #546).
// Server-only (reads the DB). The pure shape + defaults live in
// src/lib/pipeline.ts (client-safe); this module only adds the DB-backed
// resolver, so client components can share the type/defaults without Prisma.
//
// Behavior-preserving: an org with no PipelineStage rows falls back to the
// canonical stages, so single-tenant production is unchanged.

import { prisma } from './prisma';
import { defaultPipelineStages, onPathKeys, stageLabel, type ResolvedStage } from './pipeline';
import type { Locale } from '@/i18n/config';

export { defaultPipelineStages, onPathKeys, stageLabel, type ResolvedStage };

// Resolve the stages for a tenant: its custom rows if any, else the canonical
// defaults. Cheap single indexed query; falls back safely for a null org.
export async function resolvePipelineStages(
  orgId: string | null | undefined,
  locale: Locale = 'en',
): Promise<ResolvedStage[]> {
  if (orgId) {
    const rows = await prisma.pipelineStage.findMany({
      where: { orgId },
      orderBy: { order: 'asc' },
    });
    if (rows.length > 0) {
      return rows.map((r) => ({
        key: r.key,
        label: r.label,
        order: r.order,
        isTerminal: r.isTerminal,
        isOffPath: r.isOffPath,
        color: r.color,
      }));
    }
  }
  return defaultPipelineStages(locale);
}

// Resolve a tenant's CUSTOM stages, or null when it uses the built-in defaults.
// Fed to the client PipelineStagesProvider so default-stage labels can stay
// localized on the client while custom labels render as the tenant set them.
export async function resolveCustomStages(
  orgId: string | null | undefined,
): Promise<ResolvedStage[] | null> {
  if (!orgId) return null;
  const rows = await prisma.pipelineStage.findMany({ where: { orgId }, orderBy: { order: 'asc' } });
  if (rows.length === 0) return null;
  return rows.map((r) => ({
    key: r.key,
    label: r.label,
    order: r.order,
    isTerminal: r.isTerminal,
    isOffPath: r.isOffPath,
    color: r.color,
  }));
}
