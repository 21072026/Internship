// Segmenting a registry report by an org-defined attribute (#1920, part 3) —
// the pure planning half: which segments a report is split into, in which
// order, and which are too small to be shown on their own. The registry
// (registry.ts) turns each planned segment into a filter on the report's
// subject person and runs the loader once per segment. Unit-tested in
// scripts/test/report-segments.test.mjs; docs/analytics.md is the prose.
//
// THE FLOOR RUNS AFTER THE SPLIT. Segmentation multiplies small groups:
// "conversion per cohort" is safe, "per cohort, for the Munich office" can be
// three people. So a segment with fewer than `minCohort` people is never shown
// on its own — whatever the report — and the small segments are folded into
// ONE named bucket instead of being dropped, so the segments still partition
// the population and the totals reconcile. Inside every shown segment the
// report's own floor (privacyFloor.ts) runs again on its groups.
//
// A DATE attribute is segmented by TENURE, derived from the stored start date
// against `now` (tenureBucket), never by the raw date — and never stored.

import { TENURE_BUCKETS, tenureBucket } from '../orgAttributesRule';

/** People who carry no value of the attribute. */
export const SEGMENT_NONE = '__none__';
/** Segments under the floor, combined. */
export const SEGMENT_BELOW = '__below__';
/** Segments beyond the display cap, combined (each of them is above the floor). */
export const SEGMENT_OTHER = '__other__';

/** At most this many segments are shown side by side; the rest are combined. */
export const MAX_SEGMENTS = 12;

export interface PlannedSegment {
  /** The stored value, a tenure bucket, or one of the SEGMENT_* markers. */
  key: string;
  /** Stored values whose holders belong to this segment. */
  values: string[];
  /** Whether people with no value belong to this segment. */
  includesNone: boolean;
  /** People in the segment. */
  size: number;
}

export interface SegmentPlan {
  segments: PlannedSegment[];
  /** How many segments were folded into the below-threshold bucket. */
  suppressedSegments: number;
}

export interface PlanInput {
  type: string;
  options?: unknown;
  /** Stored value → number of people holding it (one grouped query). */
  counts: { value: string; count: number }[];
  /** People of the report's population with no value. */
  noneCount: number;
  minCohort: number;
  now: Date;
  maxSegments?: number;
}

/** The candidate segments before the floor: one per value (or tenure bucket), plus "no value". */
function candidates(input: PlanInput): PlannedSegment[] {
  const out: PlannedSegment[] = [];
  if (input.type === 'DATE') {
    const byBucket = new Map<string, PlannedSegment>();
    let unbucketed: PlannedSegment | null = null;
    for (const { value, count } of input.counts) {
      const bucket = tenureBucket(value, input.now);
      if (!bucket) {
        // An unreadable stored date counts as no value, never as a guess.
        unbucketed ??= { key: SEGMENT_NONE, values: [], includesNone: true, size: 0 };
        unbucketed.values.push(value);
        unbucketed.size += count;
        continue;
      }
      const seg = byBucket.get(bucket) ?? { key: bucket, values: [], includesNone: false, size: 0 };
      seg.values.push(value);
      seg.size += count;
      byBucket.set(bucket, seg);
    }
    for (const b of TENURE_BUCKETS) if (byBucket.has(b)) out.push(byBucket.get(b)!);
    const none = unbucketed ?? { key: SEGMENT_NONE, values: [], includesNone: true, size: 0 };
    none.size += input.noneCount;
    if (none.size > 0) out.push(none);
    return out;
  }
  const options = Array.isArray(input.options) ? (input.options as unknown[]).filter((o): o is string => typeof o === 'string') : [];
  const rank = (v: string) => {
    const i = options.indexOf(v);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const sorted = [...input.counts]
    .filter((c) => c.count > 0)
    .sort((a, b) => (input.type === 'SELECT' ? rank(a.value) - rank(b.value) : 0) || b.count - a.count || a.value.localeCompare(b.value));
  for (const c of sorted) out.push({ key: c.value, values: [c.value], includesNone: false, size: c.count });
  if (input.noneCount > 0) out.push({ key: SEGMENT_NONE, values: [], includesNone: true, size: input.noneCount });
  return out;
}

/**
 * Split a population into segments: the ones at or above the floor in display
 * order (at most `maxSegments`), then — when there are any — "other values"
 * and the below-threshold bucket. Every person is in exactly one segment.
 */
export function planSegments(input: PlanInput): SegmentPlan {
  const max = input.maxSegments ?? MAX_SEGMENTS;
  const all = candidates(input);
  const small = all.filter((s) => s.size < input.minCohort);
  const large = all.filter((s) => s.size >= input.minCohort);
  const shown = large.slice(0, max);
  const overflow = large.slice(max);
  const segments = [...shown];
  if (overflow.length > 0) segments.push(merge(SEGMENT_OTHER, overflow));
  if (small.length > 0) segments.push(merge(SEGMENT_BELOW, small));
  return { segments, suppressedSegments: small.length };
}

function merge(key: string, parts: PlannedSegment[]): PlannedSegment {
  return {
    key,
    values: parts.flatMap((p) => p.values),
    includesNone: parts.some((p) => p.includesNone),
    size: parts.reduce((n, p) => n + p.size, 0),
  };
}

/**
 * One requested segment for the filter mode (`segment=<value>`): the segment,
 * or `suppressed` when it is under the floor — then nothing about it is shown,
 * and the answer says so rather than returning an empty table silently.
 */
export function pickSegment(input: PlanInput, requested: string): { segment: PlannedSegment | null; suppressed: boolean } {
  const found = candidates(input).find((s) => s.key === requested);
  if (!found || found.size < input.minCohort) return { segment: null, suppressed: true };
  return { segment: found, suppressed: false };
}

/**
 * The slice a stored params blob (a report subscription's `params`, a saved
 * view's filters) asks for — `{ segmentBy, segment? }` — or null. Shapes
 * only; whether the attribute still exists is the loader's question, and it
 * answers a missing one with the unsliced report.
 */
export function segmentFromParams(params: unknown): { by: string; value: string | null } | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const p = params as Record<string, unknown>;
  if (typeof p.segmentBy !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(p.segmentBy)) return null;
  const value = typeof p.segment === 'string' && p.segment.trim() ? p.segment.trim().slice(0, 191) : null;
  return { by: p.segmentBy, value };
}
