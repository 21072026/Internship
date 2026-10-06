// The report registry's DEFINITIONS (#1903) — what each named report is, never
// how it is loaded. Pure on purpose: no Prisma, no Next, so the check:reports
// guard (scripts/check-reports.ts) and the unit tests can read it, and a
// client screen could list the catalogue without pulling a server module in.
//
// WHY A REGISTRY AND NOT A BUILDER. Every competitor ships a custom report
// builder and every one of them is still reviewed as "inflexible": the builder
// is not what wins. A small set of named, correct, exportable reports is. So
// there is no field picker, no user-defined join, no computed column here —
// a report is chosen from this list and parameterised, and that is what a
// saved view or a scheduled delivery will store (#1905). This file is the list.
//
// LABELS ARE KEYS. Every title, description and column label is a dot-path
// into the `reports` block of src/i18n/dictionaries.ts, resolved from the
// caller's locale at the route boundary — one definition serves EN, TR and DE.
// `npm run check:reports` fails on a key that is missing in any language.

import type { VerticalCapability } from '@/lib/verticals';

// `number` is a COUNT (summable across groups); `average` is a number that is
// not (the privacy floor's bucket leaves it empty — see privacyFloor.ts).
export type ColumnType = 'string' | 'number' | 'average' | 'percent' | 'date';

export interface ReportColumn {
  key: string;
  /** Dot-path under `reports` in the dictionaries, e.g. 'col.cohort'. */
  labelKey: string;
  type: ColumnType;
}

export interface ReportDefinition {
  key: string;
  titleKey: string;
  descriptionKey: string;
  columns: ReportColumn[];
  /**
   * An aggregate report's rows are GROUPS of people (a cohort, a source, a
   * company). Any group smaller than `minCohort` is suppressed into one named
   * bucket — the privacy floor, which no admin can switch off (see
   * src/lib/reports/privacyFloor.ts and docs/analytics.md).
   */
  aggregate: boolean;
  /** Smallest group an aggregate report may show on its own (default 5). */
  minCohort?: number;
  /** Aggregate reports: the column holding each group's size. */
  sizeColumn?: string;
  /** Aggregate reports: the column naming the group (the bucket's label goes here). */
  labelColumn?: string;
  /** A report that only exists for a vertical with this module. */
  capability?: VerticalCapability;
}

/** The privacy floor when a definition does not raise it. */
export const DEFAULT_MIN_COHORT = 5;

export const REPORT_DEFINITIONS: readonly ReportDefinition[] = [
  {
    key: 'pipeline-funnel',
    titleKey: 'pipelineFunnel.title',
    descriptionKey: 'pipelineFunnel.description',
    aggregate: false,
    columns: [
      { key: 'stage', labelKey: 'col.stage', type: 'string' },
      { key: 'count', labelKey: 'col.count', type: 'number' },
    ],
  },
  {
    key: 'cohort-comparison',
    titleKey: 'cohortComparison.title',
    descriptionKey: 'cohortComparison.description',
    aggregate: true,
    sizeColumn: 'total',
    labelColumn: 'cohort',
    capability: 'mentorship',
    columns: [
      { key: 'cohort', labelKey: 'col.cohort', type: 'string' },
      { key: 'total', labelKey: 'col.total', type: 'number' },
      { key: 'inProgress', labelKey: 'col.inProgress', type: 'number' },
      { key: 'reachedOutcome', labelKey: 'col.reachedOutcome', type: 'number' },
      { key: 'dropped', labelKey: 'col.dropped', type: 'number' },
      { key: 'conversion', labelKey: 'col.conversion', type: 'percent' },
      { key: 'avgDaysToOutcome', labelKey: 'col.avgDaysToOutcome', type: 'average' },
    ],
  },
  {
    key: 'source-conversion',
    titleKey: 'sourceConversion.title',
    descriptionKey: 'sourceConversion.description',
    aggregate: true,
    sizeColumn: 'total',
    labelColumn: 'source',
    columns: [
      { key: 'source', labelKey: 'col.source', type: 'string' },
      { key: 'total', labelKey: 'col.total', type: 'number' },
      { key: 'inPipeline', labelKey: 'col.inPipeline', type: 'number' },
      { key: 'reachedOutcome', labelKey: 'col.reachedOutcome', type: 'number' },
      { key: 'conversion', labelKey: 'col.conversion', type: 'percent' },
    ],
  },
  {
    key: 'mentor-workload',
    titleKey: 'mentorWorkload.title',
    descriptionKey: 'mentorWorkload.description',
    aggregate: false,
    capability: 'mentorship',
    columns: [
      { key: 'mentor', labelKey: 'col.mentor', type: 'string' },
      { key: 'active', labelKey: 'col.active', type: 'number' },
      { key: 'reachedOutcome', labelKey: 'col.reachedOutcome', type: 'number' },
    ],
  },
  {
    key: 'placement-outcomes',
    titleKey: 'placementOutcomes.title',
    descriptionKey: 'placementOutcomes.description',
    aggregate: true,
    sizeColumn: 'placements',
    labelColumn: 'company',
    capability: 'placements',
    columns: [
      { key: 'company', labelKey: 'col.company', type: 'string' },
      { key: 'placements', labelKey: 'col.placements', type: 'number' },
      { key: 'valued', labelKey: 'col.valued', type: 'number' },
    ],
  },
  {
    key: 'weekly-report-compliance',
    titleKey: 'weeklyReportCompliance.title',
    descriptionKey: 'weeklyReportCompliance.description',
    aggregate: false,
    capability: 'mentorship',
    columns: [
      { key: 'intern', labelKey: 'col.intern', type: 'string' },
      { key: 'mentor', labelKey: 'col.mentor', type: 'string' },
      { key: 'company', labelKey: 'col.company', type: 'string' },
      { key: 'expected', labelKey: 'col.expected', type: 'number' },
      { key: 'submitted', labelKey: 'col.submitted', type: 'number' },
      { key: 'missing', labelKey: 'col.missing', type: 'number' },
      { key: 'late', labelKey: 'col.late', type: 'number' },
      { key: 'rate', labelKey: 'col.rate', type: 'percent' },
    ],
  },
];

export function getReportDefinition(key: string): ReportDefinition | null {
  return REPORT_DEFINITIONS.find((d) => d.key === key) ?? null;
}
