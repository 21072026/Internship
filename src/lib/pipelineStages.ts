// Per-tenant pipeline-stage resolution (#747, part of white-label #546).
// Server-only (reads the DB).
//
// Phase A is additive + behavior-preserving: an org with no PipelineStage rows
// falls back to the built-in canonical stages (the PipelineStatus enum, mirrored
// in src/lib/pipeline.ts), so single-tenant production is unchanged. An org that
// defines rows overrides the label / order / color / on-path grouping for the
// stages it lists. Relations still store the PipelineStatus enum in this phase;
// storage moves off the enum (allowing brand-new stage keys) in a later slice.

import { prisma } from './prisma';
import { PIPELINE_STATUSES, pipelineLabel } from './pipeline';
import type { Locale } from '@/i18n/config';

export interface ResolvedStage {
  key: string;
  label: string;
  order: number;
  isTerminal: boolean;
  isOffPath: boolean;
  color: string | null;
}

// The two off-path terminal states, and the set of terminal states, for the
// canonical defaults — mirrors JourneyTracker's OFF_PATH and pipeline.ts's
// nextOnPathStatus (EMPLOYED_700 is the positive terminus).
const DEFAULT_OFF_PATH = new Set<string>(['INTERNSHIP_DROPPED_460', 'INTERNSHIP_FOUND_ELSEWHERE_800']);
const DEFAULT_TERMINAL = new Set<string>([
  'EMPLOYED_700',
  'INTERNSHIP_DROPPED_460',
  'INTERNSHIP_FOUND_ELSEWHERE_800',
]);

// The product's canonical stage set, derived from the enum so it stays the single
// source of truth. Used whenever a tenant has not customized its pipeline.
export function defaultPipelineStages(locale: Locale = 'en'): ResolvedStage[] {
  return PIPELINE_STATUSES.map((key, i) => ({
    key,
    label: pipelineLabel(key, locale),
    order: i,
    isTerminal: DEFAULT_TERMINAL.has(key),
    isOffPath: DEFAULT_OFF_PATH.has(key),
    color: null,
  }));
}

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

// The on-path sequence (excludes off-path stages), for "advance one stage"
// semantics over a resolved stage set. Mirrors nextOnPathStatus for defaults.
export function onPathKeys(stages: ResolvedStage[]): string[] {
  return stages.filter((s) => !s.isOffPath).sort((a, b) => a.order - b.order).map((s) => s.key);
}
