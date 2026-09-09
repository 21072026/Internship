// The shared import engine: parse → validate → resolve (diff) → dry run → apply.
//
// SCOPE (#2072, first consumer #1965)
//   Every importer in this product does the same five things and gets at least
//   one of them subtly wrong. `POST /api/admin/import` hand-rolls a CSV
//   splitter that cannot read a quoted embedded newline, builds its dry-run
//   report in one branch and its real writes in another (so the preview is a
//   *different program* from the run — the shape of #1432), and has no notion
//   of a row that merely changed. This module is the one engine those importers
//   run on: a caller supplies four hooks and gets a report whose preview is
//   produced by the code that applies.
//
//   It is deliberately free of Prisma, `next`, React and any transport: the
//   whole point is that it can be unit-tested with plain arrays
//   (`scripts/test/roster-ingest.test.mjs`). Persistence, chunk transactions,
//   resumability and scheduling belong to the consumer (see
//   `src/lib/rosterIngest.ts`); the engine only decides *what* each row is and
//   hands the chunks over in order.
//
// THE ONE RULE
//   A dry run is the same call with a writer that does not write. There is no
//   `if (dryRun)` fork in the planning path, because a preview that can diverge
//   from the run it previews is worse than no preview at all.

// ── The row-status vocabulary ────────────────────────────────────────────────
// One vocabulary for every importer in the tree. `RosterRowStatus` in
// prisma/schema.prisma mirrors these tokens exactly, and the parity assertion
// in src/lib/rosterIngest.ts is what keeps the two equal.
export const ROW_STATUSES = ['CREATE', 'UPDATE', 'UNCHANGED', 'SKIP', 'ERROR'] as const;
export type RowStatus = (typeof ROW_STATUSES)[number];

export interface RowResult<TValue = unknown> {
  /** 1-based position among the DATA rows (the header is not row 1). */
  row: number;
  /** The row's identity in the target system — an e-mail or an external id. */
  key: string;
  status: RowStatus;
  /** Why it is a SKIP or an ERROR, or what an UPDATE is about to touch. */
  reason?: string;
  /** Field names an UPDATE writes. Empty for every other status. */
  changed?: string[];
  /** The id of the row in the target system, once known. */
  targetId?: string | null;
  value?: TValue;
}

export interface ImportReport<TValue = unknown> {
  dryRun: boolean;
  total: number;
  counts: Record<RowStatus, number>;
  rows: RowResult<TValue>[];
  /** Keys the target holds that the feed did not mention. Reported, never acted on here. */
  absent: string[];
  /** The chunk the run started from — non-zero when a previous attempt was resumed. */
  startedAtChunk: number;
}

export function emptyCounts(): Record<RowStatus, number> {
  return { CREATE: 0, UPDATE: 0, UNCHANGED: 0, SKIP: 0, ERROR: 0 };
}

export function countRows(rows: RowResult<unknown>[]): Record<RowStatus, number> {
  const counts = emptyCounts();
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

// ── The shared delimited-text parser ─────────────────────────────────────────
// What the hand-rolled `parseLine()` in the candidate importer cannot read, and
// what a real HR export contains on day one:
//
//   • a newline inside a quoted field   (an address column, every time)
//   • CRLF line endings                 (anything that has been near Windows)
//   • a UTF-8 BOM                       (Excel's "CSV UTF-8" export)
//   • `;` as the delimiter              (Excel on a German/Turkish locale)
//   • `""` as an escaped quote          (already handled, kept)
//
// So the parser is a character state machine over the whole text rather than a
// split on `\n` followed by a split on `,`.

export const SUPPORTED_DELIMITERS = [',', ';', '\t', '|'] as const;
export type Delimiter = (typeof SUPPORTED_DELIMITERS)[number];

export interface ParsedRow {
  /** 1-based data-row number (header excluded). */
  row: number;
  values: string[];
}

export interface ParsedTable {
  header: string[];
  rows: ParsedRow[];
  delimiter: Delimiter;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Pick the delimiter from the header line, ignoring anything inside quotes.
 *
 * Counting over the whole file would let a comma-rich free-text column outvote
 * the real delimiter; the header line is the one line whose shape is fixed.
 */
export function sniffDelimiter(text: string): Delimiter {
  const firstLine = stripBom(text).split(/\r?\n/, 1)[0] ?? '';
  let best: Delimiter = ',';
  let bestCount = 0;
  for (const candidate of SUPPORTED_DELIMITERS) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < firstLine.length; i++) {
      const ch = firstLine[i];
      if (ch === '"') {
        if (inQuotes && firstLine[i + 1] === '"') i += 1;
        else inQuotes = !inQuotes;
      } else if (!inQuotes && ch === candidate) count += 1;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Parse delimited text into a header and numbered data rows.
 *
 * An unquoted field is trimmed (HR exports pad after the delimiter); a quoted
 * field is returned exactly as written, because the quotes are the author
 * saying "this whitespace and this newline are data".
 */
export function parseDelimited(raw: string, options: { delimiter?: string } = {}): ParsedTable {
  const text = stripBom(raw);
  const delimiter = (
    options.delimiter && (SUPPORTED_DELIMITERS as readonly string[]).includes(options.delimiter)
      ? options.delimiter
      : sniffDelimiter(text)
  ) as Delimiter;

  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false; // this field was written in quotes
  let inQuotes = false;

  const endField = () => {
    record.push(quoted ? field : field.trim());
    field = '';
    quoted = false;
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else if (ch === '\r' && text[i + 1] === '\n') {
        // Normalise CRLF *inside* a quoted field too — the newline is data, the
        // carriage return is a transport artefact.
        continue;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      quoted = true;
      continue;
    }
    if (ch === delimiter) {
      endField();
      continue;
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      endRecord();
      continue;
    }
    if (ch === '\n') {
      endRecord();
      continue;
    }
    field += ch;
  }
  // A file ending in a newline must not produce a trailing empty record.
  if (field.length > 0 || quoted || record.length > 0) endRecord();

  const nonEmpty = records.filter((r) => r.some((v) => v.length > 0));
  const header = nonEmpty.shift() ?? [];
  return {
    header: header.map((h) => h.trim()),
    rows: nonEmpty.map((values, index) => ({ row: index + 1, values })),
    delimiter,
  };
}

/** Case/whitespace-insensitive header lookup — `E-Mail` and `email ` are one column. */
export function headerIndex(header: string[], name: string): number {
  const wanted = name.trim().toLowerCase();
  return header.findIndex((h) => h.trim().toLowerCase() === wanted);
}

// ── The hooks ────────────────────────────────────────────────────────────────

export type ValidatedRow<TValue> =
  | { ok: true; row: number; key: string; value: TValue }
  | { ok: false; row: number; key: string; status: 'SKIP' | 'ERROR'; reason: string };

export interface PlannedRow<TValue> {
  row: number;
  key: string;
  /** Never ERROR — a row that failed validation never reaches a plan. */
  status: Exclude<RowStatus, 'ERROR'>;
  value: TValue;
  reason?: string;
  changed?: string[];
  targetId?: string | null;
}

export interface ResolveResult<TValue> {
  plan: PlannedRow<TValue>[];
  /** Keys the target holds that the feed did not mention (reported only). */
  absent: string[];
}

// Two type parameters, because the two halves of an import carry different
// shapes: `TInput` is what a row SAYS (the mapped columns), `TPlan` is what the
// diff DECIDED about it (the input plus the writes it implies). They are the
// same type for an importer that only ever creates.
export interface ImportHooks<TInput, TPlan = TInput> {
  /** Produce the table. Usually `parseDelimited(text, …)`. */
  parse: () => ParsedTable | Promise<ParsedTable>;
  /** Turn one parsed row into a typed value, or reject it. Pure and synchronous. */
  validate: (row: ParsedRow, header: string[]) => ValidatedRow<TInput>;
  /**
   * Batched diff: given every valid row, decide CREATE / UPDATE / UNCHANGED /
   * SKIP and report what the target holds and the feed does not. Batched on
   * purpose — a per-row `resolve` is one query per row.
   */
  resolve: (rows: { row: number; key: string; value: TInput }[]) => Promise<ResolveResult<TPlan>>;
  /**
   * Apply one chunk and report each row's outcome. The consumer owns the
   * transaction: everything this call writes — the target rows, the per-row
   * results and the resume checkpoint — must commit or roll back together.
   * Throwing rolls the chunk back; the engine records the chunk as ERROR and
   * carries on with the next one.
   */
  apply: (
    chunk: PlannedRow<TPlan>[],
    context: { chunkIndex: number; dryRun: boolean },
  ) => Promise<RowResult<TPlan>[]>;
  chunkSize?: number;
  dryRun?: boolean;
  /** Resume: chunks below this index are assumed already committed and are skipped. */
  startChunk?: number;
}

export const DEFAULT_CHUNK_SIZE = 100;

export function chunkRows<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  const step = Math.max(1, Math.floor(size));
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}

/** Message text that is safe to persist: never a stack, never a query. */
export function importErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split('\n')[0].slice(0, 300);
}

/**
 * Run one import. The same call performs a dry run when `dryRun` is set — the
 * planning is identical and the consumer's `apply` swaps in a writer that does
 * not write.
 */
export async function runImport<TInput, TPlan = TInput>(
  hooks: ImportHooks<TInput, TPlan>,
): Promise<ImportReport<TPlan>> {
  const dryRun = hooks.dryRun === true;
  const startChunk = Math.max(0, hooks.startChunk ?? 0);
  const table = await hooks.parse();

  const rejected: RowResult<TPlan>[] = [];
  const valid: { row: number; key: string; value: TInput }[] = [];
  for (const row of table.rows) {
    const validated = hooks.validate(row, table.header);
    if (validated.ok) valid.push({ row: validated.row, key: validated.key, value: validated.value });
    else
      rejected.push({
        row: validated.row,
        key: validated.key,
        status: validated.status,
        reason: validated.reason,
      });
  }

  const { plan, absent } = await hooks.resolve(valid);
  const chunks = chunkRows(plan, hooks.chunkSize ?? DEFAULT_CHUNK_SIZE);

  const applied: RowResult<TPlan>[] = [];
  for (let index = 0; index < chunks.length; index++) {
    if (index < startChunk) continue; // already committed by an earlier attempt
    const rows = chunks[index];
    try {
      applied.push(...(await hooks.apply(rows, { chunkIndex: index, dryRun })));
    } catch (error) {
      // The chunk rolled back as a unit: nothing it touched was written, and the
      // run continues with the next chunk. This is the property #1432 lacked —
      // one bad row could neither abort the run nor leave half a chunk behind.
      const reason = importErrorMessage(error);
      for (const row of rows) {
        applied.push({ row: row.row, key: row.key, status: 'ERROR', reason, value: row.value });
      }
    }
  }

  const rows = [...rejected, ...applied].sort((a, b) => a.row - b.row);
  return {
    dryRun,
    total: table.rows.length,
    counts: countRows(rows),
    rows,
    absent,
    startedAtChunk: startChunk,
  };
}
