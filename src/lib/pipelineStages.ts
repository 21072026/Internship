// Per-tenant pipeline-stage resolution (#747, part of white-label #546).
// Server-only (reads the DB). The pure shape + defaults live in
// src/lib/pipeline.ts (client-safe); this module only adds the DB-backed
// resolver, so client components can share the type/defaults without Prisma.
//
// Behavior-preserving: an org with no PipelineStage rows falls back to the
// canonical stages, so single-tenant production is unchanged.

import { prisma } from './prisma';
import {
  CANONICAL_OUTCOME_KEYS,
  defaultPipelineStages,
  isDefaultLabel,
  localizeStageLabels,
  onPathKeys,
  stageLabel,
  startStageKey,
  type ResolvedStage,
} from './pipeline';
import type { Locale } from '@/i18n/config';
import { defaultTemplateForVertical, templateStagePayload } from './programTemplates';

export { CANONICAL_OUTCOME_KEYS, defaultPipelineStages, isDefaultLabel, onPathKeys, stageLabel, startStageKey, type ResolvedStage };

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

// ── Writing a stage set ──────────────────────────────────────────────────────

// The ONE function that replaces an org's PipelineStage rows (#2353). Both the
// admin editor (PUT /api/admin/organizations/[id]/pipeline-stages) and org
// provisioning go through it, so the "single writer" rule the editor route
// documented still holds — the difference between them is the authz/plan check
// each does BEFORE calling this, not a second copy of the write.
//
// Label normalization is preserved: a label that is still the built-in one for
// its key is stored blank ("use the localized built-in", #2268); only a typed
// label persists. For a marketing key (no built-in) that means the label lands
// verbatim, exactly as any other non-canonical template's does.
export interface StageWrite {
  key: string;
  label: string;
  order: number;
  isTerminal?: boolean;
  isOffPath?: boolean;
  color?: string | null;
}

export async function replaceStages(orgId: string, stages: StageWrite[]): Promise<void> {
  await prisma.$transaction([
    prisma.pipelineStage.deleteMany({ where: { orgId } }),
    prisma.pipelineStage.createMany({
      data: stages.map((s) => ({
        orgId,
        key: s.key,
        label: isDefaultLabel(s.key, s.label) ? '' : s.label.trim(),
        order: s.order,
        isTerminal: s.isTerminal ?? false,
        isOffPath: s.isOffPath ?? false,
        color: s.color && s.color.trim() ? s.color.trim() : null,
      })),
    }),
  ]);
}

// Provision a new org's starting stage set from its vertical (#2353). Returns
// false when the vertical starts on the canonical set (INTERNSHIP) — the caller
// writes nothing and the resolve fallback serves the built-ins, exactly as
// before verticals existed. A MARKETING org gets the marketing funnel.
//
// This deliberately bypasses the editor route's FREE-plan gate: seeding a
// tenant at creation is provisioning by a super admin, not a tenant editing its
// own stages, and a new org is FREE by default (#547). The template is a
// pre-validated catalogue entry, so the validation the route does per request
// is already guaranteed here.
export async function provisionStagePreset(
  orgId: string,
  vertical: string,
  locale: Locale = 'en',
): Promise<boolean> {
  const template = defaultTemplateForVertical(vertical);
  if (!template) return false;
  await replaceStages(orgId, templateStagePayload(template, locale).stages);
  return true;
}

// ── "Did this person finish?" — one definition (#1882) ───────────────────────
//
// Five paid reports (cohort comparison, source conversion, the cross-program
// benchmark, the admin headline conversion and mentor analytics) each decided
// that question with their own copy of `new Set(['HIRED_660','EMPLOYED_700'])`.
// A tenant that renamed its stages (#747) holds neither key, so all five
// reported zero — not an error, not an empty state, just a confident nought.
//
// THE RULE, and why it is not simply "the last on-path stage".
//
// The obvious generalisation — finished = the last on-path key — is WRONG for
// the catalogue every live tenant is on today: the default set ends
// … HIREABLE_600 → HIRED_660 → EMPLOYED_700, and "the last key" is EMPLOYED_700
// alone. That would silently stop counting every relation parked on HIRED_660,
// which is most of them. So the rule has an ANCHOR:
//
//   anchor   = the first on-path stage (by order) whose key is one of the
//              canonical outcome keys, or — for a set that holds neither, i.e. a
//              genuinely custom pipeline — the last on-path stage.
//   finished = every on-path stage ordered at or beyond the anchor.
//
// Default catalogue → anchor HIRED_660 → { HIRED_660, EMPLOYED_700 }: byte-for-
// byte the set the five routes hardcoded. Renamed catalogue (STAGE_A…STAGE_F)
// → anchor STAGE_F → { STAGE_F }. A tenant that kept HIRED_660 and appended its
// own "Probation passed" after it counts both, which is the point of "at or
// beyond": reaching the outcome and then moving further along is still reaching
// the outcome.
//
// `offPath` is the other hardcoded set the same routes carried
// (`INTERNSHIP_DROPPED_460` / `INTERNSHIP_FOUND_ELSEWHERE_800`); for the default
// catalogue `isOffPath` marks exactly those two, so that is byte-identical too.
//
// NOT a fork of #1504's placement definition: that issue's `src/lib/placement.ts`
// does not exist on `main` (verified by `git grep`), and it is about WHICH
// RELATIONS count (coaching vs placement, employment attribution). This is about
// WHICH STAGES mean "finished" in a tenant's own vocabulary. When #1504 lands it
// should read `finished` from here rather than re-listing stage keys.

export interface OutcomeStageKeys {
  /** Stage keys that mean "reached the outcome", in the tenant's own order. */
  finished: string[];
  /**
   * What the tenant calls the anchor stage, in the caller's locale — so a
   * screen can NAME the thing it counted instead of asserting a universal
   * "Hired". Empty only for the degenerate set with no on-path stage at all.
   */
  finishedLabel: string;
  /**
   * False when `finishedLabel` is merely our own built-in label for a built-in
   * key — i.e. the tenant never named this stage. A screen that already has a
   * good word of its own ("Hired", "İşe alınan", "Eingestellt", translated in
   * all three dictionaries) should keep using it in that case, so a tenant on
   * the default catalogue sees exactly the text it saw before #1882. True means
   * the tenant typed a name, and that name must win.
   */
  finishedLabelIsCustom: boolean;
  /** Off-path stage keys ("dropped", "found elsewhere"), in tenant order. */
  offPath: string[];
  /** The stage a journey starts on — the single definition in `startStageKey`. */
  first: string;
}

/**
 * The synchronous core, for a caller that already holds resolved stages — the
 * benchmark loop, which resolves many orgs at once and must not re-query per
 * org. `stages` must already be localized (`resolvePipelineStages` does it).
 */
export function outcomeStageKeysFrom(stages: ResolvedStage[]): OutcomeStageKeys {
  const byOrder = [...stages].sort((a, b) => a.order - b.order);
  const onPath = byOrder.filter((s) => !s.isOffPath);
  const anchor =
    onPath.find((s) => (CANONICAL_OUTCOME_KEYS as readonly string[]).includes(s.key)) ??
    onPath[onPath.length - 1];

  return {
    finished: anchor ? onPath.filter((s) => s.order >= anchor.order).map((s) => s.key) : [],
    finishedLabel: anchor?.label ?? '',
    // `isDefaultLabel` matches a built-in label in ANY locale, which is exactly
    // right here: a stage nobody renamed resolves to one of our own strings, a
    // renamed one does not, and a custom KEY has no built-in label at all.
    finishedLabelIsCustom: anchor ? !isDefaultLabel(anchor.key, anchor.label) : false,
    offPath: byOrder.filter((s) => s.isOffPath).map((s) => s.key),
    first: startStageKey(stages),
  };
}

/** Resolve a tenant's stages and reduce them to the outcome sets above. */
export async function outcomeStageKeys(
  orgId: string | null | undefined,
  locale: Locale = 'en',
): Promise<OutcomeStageKeys> {
  return outcomeStageKeysFrom(await resolvePipelineStages(orgId, locale));
}
