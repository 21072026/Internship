// The admin CSV import's row rules (#1432) — pure, so the dry run and the real
// run cannot decide by different rules again, and so a unit test can throw
// every malformed file at it without a database.
//
// What went wrong before: the route checked only the e-mail, so a 250-character
// name passed the dry run ("will create 1") and then died in the INSERT with
// Prisma P2000 — an empty 500, with every row before it already written and
// none after. Every length here is the column's (TEXT_LIMITS), and a row that
// breaks one is REPORTED, never thrown.
//
// Since #2072 these are the HOOKS of the shared engine (src/lib/importPreview.ts):
// `candidateTable` is its `parse` (on the shared `parseDelimited`, so a quoted
// newline, `;` from a German Excel, CRLF and a BOM all read — this file used to
// carry its own line splitter, the shape docs/roster-feed.md forbids), and
// `validateCandidate` / `planCandidates` are its `validate` / `resolve` minus
// the database lookup the route does in bulk.

import { TEXT_LIMITS } from './textLimits';
import { headerIndex, parseDelimited, type ParsedRow, type ParsedTable, type PlannedRow, type ValidatedRow } from './importPreview';

export interface ImportRow {
  /** 1-based, counted after the header — the number the report shows. */
  row: number;
  fullName: string;
  email: string;
  phone: string;
  university: string;
  department: string;
}

/** The columns, in the order a header-less file gives them. */
export const CANDIDATE_COLUMNS = ['fullName', 'email', 'phone', 'university', 'department'] as const;

/**
 * Columns: fullName,email[,phone,university,department]. A first line naming
 * an `email` column is a header — then each column is found by its name, in
 * any order — and is dropped; without one, the first line is data and the
 * columns are positional. A UTF-8 BOM and blank lines are ignored.
 *
 * The table it returns is normalized: the header is CANDIDATE_COLUMNS and
 * every row's values are in that order, numbered from 1 after the header.
 */
export function candidateTable(csv: string): ParsedTable {
  const raw = parseDelimited(csv);
  const hasHeader = raw.header.some((cell) => cell.trim().toLowerCase() === 'email');
  const records = hasHeader ? raw.rows.map((r) => r.values) : [raw.header, ...raw.rows.map((r) => r.values)].filter((v) => v.length > 0);
  const index = CANDIDATE_COLUMNS.map((name, position) => {
    if (!hasHeader) return position;
    const found = headerIndex(raw.header, name);
    return found >= 0 ? found : position;
  });
  return {
    header: [...CANDIDATE_COLUMNS],
    rows: records.map((values, i) => ({ row: i + 1, values: index.map((at) => (values[at] ?? '').trim()) })),
    delimiter: raw.delimiter,
  };
}

function toImportRow(r: ParsedRow): ImportRow {
  const [fullName = '', email = '', phone = '', university = '', department = ''] = r.values;
  return { row: r.row, fullName, email, phone, university, department };
}

/** The rows of a file, as the importer reads them. */
export function parseImportCsv(csv: string): ImportRow[] {
  return candidateTable(csv).rows.map(toImportRow);
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// The column each field lands in, and the most it can hold.
const FIELD_LIMITS: [keyof ImportRow, number][] = [
  ['fullName', TEXT_LIMITS.userFullName],
  ['phone', TEXT_LIMITS.userPhone],
  ['university', TEXT_LIMITS.profileShortText],
  ['department', TEXT_LIMITS.profileShortText],
];

/** Why this row cannot be written, or null. Independent of the database. */
export function rowProblem(r: ImportRow): string | null {
  if (!r.email || !EMAIL_RE.test(r.email)) return 'invalid email';
  if (r.email.length > TEXT_LIMITS.userEmail) return 'email too long';
  for (const [field, max] of FIELD_LIMITS) {
    if (String(r[field]).length > max) return `${field} too long (max ${max})`;
  }
  return null;
}

/** The engine's `validate`: the same check for the preview and the run. */
export function validateCandidate(row: ParsedRow): ValidatedRow<ImportRow> {
  const r = toImportRow(row);
  const problem = rowProblem(r);
  return problem ? { ok: false, row: r.row, key: r.email, status: 'ERROR', reason: problem } : { ok: true, row: r.row, key: r.email, value: r };
}

/** What a CREATE row writes. */
export interface CandidateData {
  email: string;
  fullName: string;
  phone: string | null;
  university: string | null;
  department: string | null;
}

export interface CandidatePlan {
  data: CandidateData;
  /** Look-alike existing candidates (#841) — warn-only, filled in by the route. */
  possibleDuplicates?: { id: string; fullName: string; matchedOn: string[] }[];
}

/**
 * The verdict for every valid row. `taken` holds the lower-cased addresses that
 * already have an account in the importing admin's world (#2590). A second
 * occurrence of an address inside the same file is skipped like an existing
 * one — the dry run used to promise both.
 */
export function planCandidates(rows: { row: number; key: string; value: ImportRow }[], taken: ReadonlySet<string>): PlannedRow<CandidatePlan>[] {
  const seen = new Set<string>();
  return rows.map(({ row, key, value: r }) => {
    const email = r.email.toLowerCase();
    const data: CandidateData = {
      email,
      fullName: r.fullName || email.split('@')[0],
      phone: r.phone || null,
      university: r.university || null,
      department: r.department || null,
    };
    if (taken.has(email)) return { row, key, status: 'SKIP', reason: 'already exists', value: { data } };
    if (seen.has(email)) return { row, key, status: 'SKIP', reason: 'duplicate in file', value: { data } };
    seen.add(email);
    return { row, key, status: 'CREATE', value: { data } };
  });
}
