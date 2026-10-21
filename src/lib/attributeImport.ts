// The attribute-value import (#1920, part 2) — the pure half: which column is
// which attribute, and what one row says. It runs on the ONE import engine
// (`runImport` in src/lib/importPreview.ts) with the shared parser; the
// Prisma-aware resolve/apply live in src/lib/attributeImportStore.ts.
// Unit-tested in scripts/test/attribute-import.test.mjs.
//
// THE FILE: one row per person, matched on `email`; every other column is an
// attribute, named by its key or by its label in any of the three languages
// (case-insensitive). An empty cell leaves that person's value as it is — the
// import never clears a value, so a partial export cannot wipe data. An unknown
// column refuses the whole file (a typo must not import half the columns
// silently); an invalid cell makes its row an ERROR naming the column.

import { headerIndex, type ParsedRow, type ValidatedRow } from './importPreview';
import { normalizeValue } from './orgAttributesRule';

export const ATTRIBUTE_IMPORT_MAX_ROWS = 5000;
/** Characters of file text one run accepts. */
export const ATTRIBUTE_IMPORT_MAX_CHARS = 2_000_000;

export interface ImportAttribute {
  id: string;
  key: string;
  labelEn: string;
  labelTr: string;
  labelDe: string;
  type: string;
  options: unknown;
}

export interface ColumnMap {
  emailIndex: number;
  /** Header position → attribute. */
  columns: { index: number; attribute: ImportAttribute }[];
}

export type ColumnMapResult = { ok: true; map: ColumnMap } | { ok: false; code: 'no_email_column' | 'unknown_column' | 'duplicate_column' | 'no_attribute_column'; column?: string };

/** Map the header onto the org's attributes, or say exactly why the file cannot be read. */
export function mapColumns(header: string[], attributes: ImportAttribute[]): ColumnMapResult {
  const emailIndex = ['email', 'e-mail', 'e-posta'].map((n) => headerIndex(header, n)).find((i) => i >= 0) ?? -1;
  if (emailIndex < 0) return { ok: false, code: 'no_email_column' };
  const columns: ColumnMap['columns'] = [];
  const seen = new Set<string>();
  for (let index = 0; index < header.length; index++) {
    if (index === emailIndex) continue;
    const name = header[index].trim().toLowerCase();
    if (!name) continue;
    const attribute = attributes.find((a) => [a.key, a.labelEn, a.labelTr, a.labelDe].some((n) => n && n.trim().toLowerCase() === name));
    if (!attribute) return { ok: false, code: 'unknown_column', column: header[index] };
    if (seen.has(attribute.id)) return { ok: false, code: 'duplicate_column', column: header[index] };
    seen.add(attribute.id);
    columns.push({ index, attribute });
  }
  if (columns.length === 0) return { ok: false, code: 'no_attribute_column' };
  return { ok: true, map: { emailIndex, columns } };
}

/** attributeId → normalised value, for the cells that were filled in. */
export type AttributeRowValue = Record<string, string>;

/** One parsed row → its email and normalised values, or a SKIP/ERROR with the reason. */
export function validateAttributeRow(row: ParsedRow, map: ColumnMap): ValidatedRow<AttributeRowValue> {
  // Stored addresses are trimmed and lower-cased (userWorld.ts normalizeEmail).
  const email = (row.values[map.emailIndex] ?? '').trim().toLowerCase();
  if (!email || !email.includes('@')) return { ok: false, row: row.row, key: email, status: 'ERROR', reason: 'invalid_email' };
  const value: AttributeRowValue = {};
  const errors: string[] = [];
  for (const { index, attribute } of map.columns) {
    const raw = row.values[index] ?? '';
    if (!raw.trim()) continue;
    const result = normalizeValue(attribute, raw);
    if (result.ok) value[attribute.id] = result.value;
    else errors.push(`${attribute.key}: ${result.code}`);
  }
  if (errors.length > 0) return { ok: false, row: row.row, key: email, status: 'ERROR', reason: errors.join('; ') };
  if (Object.keys(value).length === 0) return { ok: false, row: row.row, key: email, status: 'SKIP', reason: 'no_values' };
  return { ok: true, row: row.row, key: email, value };
}

/** The attribute ids whose stored value a row would change. */
export function changedAttributes(next: AttributeRowValue, current: Map<string, string>): string[] {
  return Object.entries(next)
    .filter(([attributeId, v]) => current.get(attributeId) !== v)
    .map(([attributeId]) => attributeId);
}
