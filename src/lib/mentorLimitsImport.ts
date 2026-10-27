// The mentor-limits import (#1808, part 2) — the pure half: which column is
// which limit, what one row says, and what it would change. It runs on the ONE
// import engine (`runImport` in src/lib/importPreview.ts) with the shared
// parser; the Prisma-aware resolve/apply live in src/lib/mentorLimitsImportStore.ts.
// Unit-tested in scripts/test/mentor-limits-import.test.mjs.
//
// THE FILE: one row per mentor, matched on `email`, with any of
//   mentorCapacity, selfMatchLimit, acceptingMentees  → written onto User
//   minNoticeMinutes, maxPerMonth                     → written onto the mentor's
//                                                      MentorBookingPolicy row (#2003)
// The last two keep #2003's names AND units (minutes, not hours); this importer
// owns no column of its own for them. An empty cell leaves that value as it is;
// a single `-` clears it (null = "no limit"). An unknown column refuses the
// whole file; an invalid cell makes its row an ERROR naming the column.

import { headerIndex, type ParsedRow, type ValidatedRow } from './importPreview';
import { POLICY_LIMITS } from './bookingPolicyRule';

export const MENTOR_LIMITS_IMPORT_MAX_ROWS = 5000;
export const MENTOR_LIMITS_IMPORT_MAX_CHARS = 1_000_000;

export const USER_LIMIT_FIELDS = ['mentorCapacity', 'selfMatchLimit', 'acceptingMentees'] as const;
export const POLICY_LIMIT_FIELDS = ['minNoticeMinutes', 'maxPerMonth'] as const;
export const LIMIT_FIELDS = [...USER_LIMIT_FIELDS, ...POLICY_LIMIT_FIELDS] as const;
export type LimitField = (typeof LIMIT_FIELDS)[number];

/** Same bounds as the screens that edit these values: /api/profile and /api/availability/policy. */
const INT_BOUNDS: Record<Exclude<LimitField, 'acceptingMentees'>, { min: number; max: number }> = {
  mentorCapacity: { min: 0, max: 100 },
  selfMatchLimit: { min: 0, max: 100 },
  minNoticeMinutes: POLICY_LIMITS.minNoticeMinutes,
  maxPerMonth: POLICY_LIMITS.maxPerMonth,
};

const TRUE_WORDS = new Set(['true', 'yes', '1', 'y', 'ja', 'evet', 'x']);
const FALSE_WORDS = new Set(['false', 'no', '0', 'n', 'nein', 'hayır', 'hayir']);
export const CLEAR_TOKEN = '-';

export interface LimitsColumnMap {
  emailIndex: number;
  columns: { index: number; field: LimitField }[];
}

export type LimitsColumnMapResult =
  | { ok: true; map: LimitsColumnMap }
  | { ok: false; code: 'no_email_column' | 'unknown_column' | 'duplicate_column' | 'no_limit_column'; column?: string };

export function mapLimitColumns(header: string[]): LimitsColumnMapResult {
  const emailIndex = ['email', 'e-mail', 'e-posta'].map((n) => headerIndex(header, n)).find((i) => i >= 0) ?? -1;
  if (emailIndex < 0) return { ok: false, code: 'no_email_column' };
  const columns: LimitsColumnMap['columns'] = [];
  const seen = new Set<LimitField>();
  for (let index = 0; index < header.length; index++) {
    if (index === emailIndex) continue;
    const name = header[index].trim().toLowerCase();
    if (!name) continue;
    const field = LIMIT_FIELDS.find((f) => f.toLowerCase() === name);
    if (!field) return { ok: false, code: 'unknown_column', column: header[index] };
    if (seen.has(field)) return { ok: false, code: 'duplicate_column', column: header[index] };
    seen.add(field);
    columns.push({ index, field });
  }
  if (columns.length === 0) return { ok: false, code: 'no_limit_column' };
  return { ok: true, map: { emailIndex, columns } };
}

/** The filled-in cells of one row. `null` = clear that value. */
export type LimitsRowValue = Partial<{
  mentorCapacity: number | null;
  selfMatchLimit: number | null;
  acceptingMentees: boolean | null;
  minNoticeMinutes: number | null;
  maxPerMonth: number | null;
}>;

function parseCell(field: LimitField, raw: string): { ok: true; value: number | boolean | null } | { ok: false; code: string } {
  const text = raw.trim();
  if (text === CLEAR_TOKEN) return { ok: true, value: null };
  if (field === 'acceptingMentees') {
    const word = text.toLowerCase();
    if (TRUE_WORDS.has(word)) return { ok: true, value: true };
    if (FALSE_WORDS.has(word)) return { ok: true, value: false };
    return { ok: false, code: 'not_boolean' };
  }
  if (!/^\d+$/.test(text)) return { ok: false, code: 'not_integer' };
  const n = Number(text);
  const { min, max } = INT_BOUNDS[field];
  if (n < min || n > max) return { ok: false, code: 'out_of_range' };
  return { ok: true, value: n };
}

export function validateLimitsRow(row: ParsedRow, map: LimitsColumnMap): ValidatedRow<LimitsRowValue> {
  // Stored addresses are trimmed and lower-cased (userWorld.ts normalizeEmail).
  const email = (row.values[map.emailIndex] ?? '').trim().toLowerCase();
  if (!email || !email.includes('@')) return { ok: false, row: row.row, key: email, status: 'ERROR', reason: 'invalid_email' };
  const value: Record<string, number | boolean | null> = {};
  const errors: string[] = [];
  for (const { index, field } of map.columns) {
    const raw = row.values[index] ?? '';
    if (!raw.trim()) continue;
    const parsed = parseCell(field, raw);
    if (parsed.ok) value[field] = parsed.value;
    else errors.push(`${field}: ${parsed.code}`);
  }
  if (errors.length > 0) return { ok: false, row: row.row, key: email, status: 'ERROR', reason: errors.join('; ') };
  if (Object.keys(value).length === 0) return { ok: false, row: row.row, key: email, status: 'SKIP', reason: 'no_values' };
  return { ok: true, row: row.row, key: email, value: value as LimitsRowValue };
}

export interface CurrentLimits {
  mentorCapacity: number | null;
  selfMatchLimit: number | null;
  acceptingMentees: boolean | null;
  /** null when the mentor has no MentorBookingPolicy row yet. */
  policy: { minNoticeMinutes: number | null; maxPerMonth: number | null; maxPerWeek: number | null } | null;
}

/** The fields a row would actually change, in LIMIT_FIELDS order. */
export function changedLimits(value: LimitsRowValue, current: CurrentLimits): LimitField[] {
  return LIMIT_FIELDS.filter((f) => {
    if (!(f in value)) return false;
    const have = (POLICY_LIMIT_FIELDS as readonly string[]).includes(f)
      ? (current.policy?.[f as 'minNoticeMinutes' | 'maxPerMonth'] ?? null)
      : current[f as (typeof USER_LIMIT_FIELDS)[number]];
    return value[f] !== have;
  });
}

/**
 * A monthly cap below the mentor's weekly one would make the weekly one a lie —
 * the same refusal as PUT /api/availability/policy, checked against the row's
 * resulting state.
 */
export function belowWeeklyCap(value: LimitsRowValue, current: CurrentLimits): boolean {
  if (!('maxPerMonth' in value) || value.maxPerMonth == null) return false;
  const weekly = current.policy?.maxPerWeek ?? null;
  return weekly != null && value.maxPerMonth < weekly;
}
