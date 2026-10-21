// Turning a loaded report into what a reader sees (#1903): localized column
// labels, the privacy-floor bucket's name, percent cells, and the CSV text.
// Shared by GET /api/admin/reports/[key] and the export workbooks
// (workbooks.ts), so a report reads the same in a single-report download and
// as a sheet of the analytics workbook. Pure — the caller hands in the
// already-resolved `reports` dictionary block.

import type { ReportDefinition } from './definitions';
import { SUPPRESSED_LABEL, type Row } from './privacyFloor';
import type { LoadedReport } from './registry';

export type Cell = string | number;

/** One sheet of a workbook — the shape src/lib/excel.ts writes. */
export interface Sheet {
  name: string;
  columns: string[];
  rows: Cell[][];
}

type Dict = Record<string, unknown> & { suppressedBucket: string; floorNote: string };

export function pick(obj: unknown, path: string): string | undefined {
  const v = path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
  return typeof v === 'string' ? v : undefined;
}

function cell(def: ReportDefinition, key: string, value: Row[string], bucketLabel: string): Cell {
  if (value === null || value === undefined) return '';
  if (value === SUPPRESSED_LABEL && key === def.labelColumn) return bucketLabel;
  const type = def.columns.find((c) => c.key === key)?.type;
  if (type === 'percent' && typeof value === 'number') return `${value}%`;
  return value;
}

export interface RenderedReport {
  title: string;
  description: string;
  columns: { key: string; label: string; type: string }[];
  /** Display cells, row by row, in column order. */
  body: Cell[][];
  bucketLabel: string;
  /** The floor's explanation, or null for a row-level report. */
  floorNote: string | null;
}

export function renderReport(def: ReportDefinition, loaded: LoadedReport, R: Dict): RenderedReport {
  const bucketLabel = loaded.minCohort ? R.suppressedBucket.replace('{n}', String(loaded.minCohort)) : '';
  // The groupBy variant of a sliced report (#1920): every row carries its
  // segment's display name (already in the reader's language), shown first.
  const grouped = !!loaded.segment && loaded.segment.value === null;
  const columns = def.columns.map((c) => ({ key: c.key, label: pick(R, c.labelKey) ?? c.key, type: c.type }));
  return {
    title: pick(R, def.titleKey) ?? def.key,
    description: pick(R, def.descriptionKey) ?? '',
    columns: grouped ? [{ key: 'segment', label: loaded.segment!.label, type: 'string' }, ...columns] : columns,
    body: loaded.rows.map((r) => [
      ...(grouped ? [String(r.segment ?? '')] : []),
      ...def.columns.map((c) => cell(def, c.key, r[c.key], bucketLabel)),
    ]),
    bucketLabel,
    floorNote: loaded.minCohort ? R.floorNote.replace('{n}', String(loaded.minCohort)) : null,
  };
}

/**
 * A rendered report as one workbook sheet. The floor's note travels with the
 * rows whenever something was merged, so a forwarded file still explains why
 * a group is missing.
 */
export function reportSheet(name: string, rendered: RenderedReport, loaded: LoadedReport): Sheet {
  const rows = [...rendered.body];
  const suppressedSegments = loaded.segment ? loaded.segment.suppressedSegments : 0;
  if (rendered.floorNote && (loaded.suppressedGroups > 0 || suppressedSegments > 0)) rows.push([], [rendered.floorNote]);
  return { name, columns: rendered.columns.map((c) => c.label), rows };
}

/** RFC 4180 CSV with a BOM, so Excel opens UTF-8 (umlauts, Turkish letters) correctly. */
export function toCsv(sheet: Sheet): string {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return '﻿' + [sheet.columns, ...sheet.rows].map((row) => row.map(esc).join(',')).join('\n');
}
