// The one response both open-text insight routes (#2046) answer with. The
// routes own the session, the capability gate and the rate limit; this file
// turns a validated request into rows, a summary (stored or fresh) and the
// numbers that render with AI off.
//
//   GET  — `peek`: the stored summary for exactly the current rows, or none.
//          Never a provider call, so loading the page spends nothing.
//   POST — `run`: the summary through runOpenTextSummary (floor → cache →
//          quota → provider), `regenerate` to skip the stored one.
// Either way the numbers come back; only the summary can be missing.

import type { Session } from 'next-auth';
import { z } from 'zod';
import { isAiConfigured } from '@/lib/ai/provider';
import { settingsOrgOf } from '@/lib/settingsOrg';
import type { Locale } from '@/i18n/config';
import { belowFloor, countUsable, type OpenTextCaveat, type OpenTextSummary } from '@/lib/ai/openTextRules';
import { peekOpenTextSummary, runOpenTextSummary } from '@/lib/ai/summarizeOpenText';
import type { AiArtifactRef } from '@/lib/aiGate';
import {
  INSIGHT_PURPOSE,
  INSIGHT_SCOPE,
  NAMED_ROWS_FLOOR,
  loadInsightSources,
  weeklyDigestFigures,
  type InsightFilters,
  type InsightKind,
  type SourceRow,
  type WeeklyDigestFigures,
} from '@/lib/insights/openTextSources';

const DAY = 24 * 60 * 60 * 1000;
/** The window a screen opens on: a quarter of evaluations, a month of diaries. */
export const DEFAULT_WINDOW_DAYS: Record<InsightKind, number> = { evaluations: 90, 'weekly-reports': 28 };
const MAX_WINDOW_DAYS = 366;

const isoDate = z.string().max(40).refine((v) => !Number.isNaN(new Date(v).getTime()), 'invalid date');

export const insightFiltersSchema = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    cohortId: z.string().min(1).max(64).optional(),
    regenerate: z.boolean().optional(),
  })
  .strict();

export type InsightRequest = z.infer<typeof insightFiltersSchema>;

/** The request's window, defaulted and bounded (a year at most: one prompt, not an archive). */
export function resolveFilters(kind: InsightKind, input: InsightRequest, now = new Date()): InsightFilters | null {
  const to = input.to ? new Date(input.to) : now;
  const from = input.from ? new Date(input.from) : new Date(to.getTime() - DEFAULT_WINDOW_DAYS[kind] * DAY);
  if (from > to || to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY) return null;
  return { from, to, cohortId: input.cohortId ?? null };
}

export interface InsightTheme {
  label: string;
  count: number;
  /** Distinct interns behind the theme — "recurring" means more than one. */
  people: number;
  exampleIds: string[];
  sentiment: OpenTextSummary['themes'][number]['sentiment'];
}

export interface InsightsBody {
  kind: InsightKind;
  from: string;
  to: string;
  available: number;
  floor: number;
  configured: boolean;
  summary: (Omit<OpenTextSummary, 'themes'> & { themes: InsightTheme[] }) | null;
  cached: boolean;
  artifact: AiArtifactRef | null;
  reason: string | null;
  caveats: OpenTextCaveat[];
  /** Only the rows a theme or a quote points at — what the click-through opens. */
  sources: SourceRow[];
  figures: WeeklyDigestFigures | null;
}

function withPeople(summary: OpenTextSummary, sources: Map<string, SourceRow>): InsightsBody['summary'] {
  return {
    ...summary,
    themes: summary.themes.map((t) => ({
      ...t,
      people: new Set(t.exampleIds.map((id) => sources.get(id)?.menteeId).filter(Boolean)).size,
    })),
  };
}

export async function insightsResponse(
  session: Session,
  kind: InsightKind,
  filters: InsightFilters,
  locale: Locale,
  mode: { run: false } | { run: true; regenerate?: boolean },
): Promise<InsightsBody> {
  const [{ items, sources, names }, figures] = await Promise.all([
    loadInsightSources(session, kind, filters),
    kind === 'weekly-reports' ? weeklyDigestFigures(session, filters) : Promise.resolve(null),
  ]);
  const base = {
    scope: INSIGHT_SCOPE[kind],
    orgId: await settingsOrgOf(session),
    items,
    purpose: INSIGHT_PURPOSE[kind],
    locale,
    floor: NAMED_ROWS_FLOOR,
    names,
  };
  const body: InsightsBody = {
    kind,
    from: filters.from.toISOString(),
    to: filters.to.toISOString(),
    available: countUsable(items),
    floor: NAMED_ROWS_FLOOR,
    configured: isAiConfigured(),
    summary: null,
    cached: false,
    artifact: null,
    reason: null,
    caveats: [],
    sources: [],
    figures,
  };

  let summary: OpenTextSummary | null = null;
  if (!mode.run) {
    const refusal = belowFloor(items, NAMED_ROWS_FLOOR);
    if (refusal) {
      body.reason = 'below_floor';
      body.caveats = [refusal];
    } else {
      const hit = await peekOpenTextSummary(base);
      if (hit) {
        summary = hit.summary;
        body.cached = true;
        body.artifact = hit.artifact;
      }
    }
  } else {
    const outcome = await runOpenTextSummary({ ...base, userId: session.user.id, regenerate: mode.regenerate });
    if (outcome.ok) {
      summary = outcome.summary;
      body.cached = outcome.cached;
      body.artifact = outcome.artifact;
    } else {
      body.reason = outcome.reason;
      if ('caveats' in outcome) body.caveats = outcome.caveats;
    }
  }
  if (summary) {
    body.summary = withPeople(summary, sources);
    body.caveats = summary.caveats;
    const ids = new Set([...summary.themes.flatMap((t) => t.exampleIds), ...summary.notableQuotes.map((q) => q.id)]);
    body.sources = [...ids].map((id) => sources.get(id)).filter((s): s is SourceRow => !!s);
  }
  return body;
}
