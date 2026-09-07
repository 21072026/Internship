// Per-tenant pipeline-stage resolution (#747, part of white-label #546).
// Server-only (reads the DB). The pure shape + defaults live in
// src/lib/pipeline.ts (client-safe); this module only adds the DB-backed
// resolver, so client components can share the type/defaults without Prisma.
//
// Behavior-preserving: an org with no PipelineStage rows falls back to the
// canonical stages, so single-tenant production is unchanged.

import { prisma } from './prisma';
import {
  defaultPipelineStages,
  isDefaultLabel,
  localizeStageLabels,
  onPathKeys,
  stageLabel,
  startStageKey,
  type ResolvedStage,
} from './pipeline';
import type { Locale } from '@/i18n/config';

export { defaultPipelineStages, isDefaultLabel, onPathKeys, stageLabel, startStageKey, type ResolvedStage };

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
      // A row the tenant never renamed reads back in the CALLER'S locale, not
      // in whatever language the editor happened to persist (#2268).
      return localizeStageLabels(
        rows.map((r) => ({
          key: r.key,
          label: r.label,
          order: r.order,
          isTerminal: r.isTerminal,
          isOffPath: r.isOffPath,
          color: r.color,
        })),
        locale,
      );
    }
  }
  return defaultPipelineStages(locale);
}

// Resolve a tenant's CUSTOM stages, or null when it uses the built-in defaults.
// Fed to the client PipelineStagesProvider so default-stage labels can stay
// localized on the client while custom labels render as the tenant set them.
// Deliberately locale-free: the labels go out raw (a not-renamed one possibly
// blank) and the client hook localizes them in the viewer's own locale.
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

// The stage a relation created RIGHT NOW in this tenant must start on (#1634).
//
// One helper for every create path so the four of them cannot drift: the admin
// assignment (POST /api/mentorship), the mentor's own "add a mentee" form, the
// mentorship-request approval and the invitation auto-link. Each one used to let
// the schema default apply, which put the relation on `APPLICATION_100` even in
// an org whose stage set does not contain that key.
//
// Seeders and the legacy CSV importer are deliberately NOT routed through this:
// they carry a real, intended stage per row (a spreadsheet's status column, a
// demo journey) and must keep writing it verbatim.
export async function resolveStartStage(
  orgId: string | null | undefined,
  locale: Locale = 'en',
): Promise<string> {
  return startStageKey(await resolvePipelineStages(orgId, locale));
}

/** Resolves an org's start stage; see `createStartStageResolver`. */
export type StartStageResolver = (orgId: string | null | undefined) => Promise<string>;

// The same lookup, memoized for a caller that asks about many relations at once
// — the daily dormancy sweep and the mentor onboarding checklist both walk a
// whole roster and would otherwise re-query per row.
//
// Deliberately per-call rather than module-level: an admin who edits the stage
// set must not be answered from a cache that outlives the request. There is one
// definition of "the first stage" in the codebase (`startStageKey`) and every
// reader goes through it or through this.
export function createStartStageResolver(locale: Locale = 'en'): StartStageResolver {
  const cache = new Map<string, string>();
  return async (orgId) => {
    const cacheKey = orgId ?? '';
    const hit = cache.get(cacheKey);
    if (hit !== undefined) return hit;
    const key = await resolveStartStage(orgId, locale);
    cache.set(cacheKey, key);
    return key;
  };
}
