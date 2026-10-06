// When a negative open-text cluster flags a pair on the at-risk queue (#2046)
// — pure, unit-tested (scripts/test/feedback-flag.test.mjs). The server half
// (which artefacts, which relation each row belongs to) is feedbackFlags.ts.
//
// THE RULE
//   • Only a theme whose sentiment is `negative` raises a flag — `unclear` and
//     `neutral` never do. Sentiment is already a majority of the theme's own
//     rows (openTextRules.ts), so one sour line does not make a cluster.
//   • A flag is a NOTE beside a pair, never a verdict: it does not change the
//     score, the band, the stage or anything stored on the relation. The
//     published health rules (docs/relationship-health.md) stay exactly what
//     they say they are; a person reads the rows and decides.
//   • Only the NEWEST summary of each kind counts. An older summary whose
//     cluster the next one no longer finds is history, not a signal.

import type { OpenTextSummary } from '@/lib/ai/openTextRules';

export interface FeedbackFlag {
  /** Labels of the negative themes this pair's rows sit in (at most three). */
  themes: string[];
  /** When the summary that raised it was made. */
  at: string;
}

/** Row id → the negative theme labels it appears in. */
export function negativeThemeRows(summary: Pick<OpenTextSummary, 'themes'>): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const theme of summary.themes) {
    if (theme.sentiment !== 'negative') continue;
    for (const id of theme.exampleIds) rows.set(id, [...new Set([...(rows.get(id) ?? []), theme.label])]);
  }
  return rows;
}

/**
 * Fold the newest summary of each kind into one flag per relation.
 * `relationOf` maps a source row id to its relation (unknown ids — a row
 * deleted since — are skipped).
 */
export function flagsByRelation(
  summaries: { summary: Pick<OpenTextSummary, 'themes'>; at: Date }[],
  relationOf: Map<string, string>,
): Map<string, FeedbackFlag> {
  const flags = new Map<string, FeedbackFlag>();
  for (const { summary, at } of summaries) {
    for (const [rowId, labels] of negativeThemeRows(summary)) {
      const relationId = relationOf.get(rowId);
      if (!relationId) continue;
      const prev = flags.get(relationId);
      flags.set(relationId, {
        themes: [...new Set([...(prev?.themes ?? []), ...labels])].slice(0, 3),
        at: prev && prev.at > at.toISOString() ? prev.at : at.toISOString(),
      });
    }
  }
  return flags;
}
