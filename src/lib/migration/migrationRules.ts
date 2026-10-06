// Mid-programme migration (#2073) — the pure half: how a sheet's columns are
// found, what a valid row is, how a source stage becomes one of ours, and how
// a pair's stage history is ordered and checked. No Prisma, no session —
// unit-tested in scripts/test/migration-rules.test.mjs. The database half is
// src/lib/migration/runMigration.ts; both run on the shared import engine
// (src/lib/importPreview.ts, #2072).
//
// THE RULES THAT ARE NOT NEGOTIABLE
//   • A source stage nobody mapped is an ERROR on its row. Never a silent
//     default to the start stage: a pair that lands in the wrong stage looks
//     right and is wrong for the rest of the programme.
//   • A stage-history row from X to X is never written (#934 — it renders as
//     "100 · İlk temas → 100 · İlk temas"). Neither is a row dated in the
//     future.
//   • A pair's current stage is the target of its LAST history row — one
//     source of truth, never a separate column that can disagree with it.
//   • People are keyed on the lower-cased e-mail and pairs on
//     (mentor e-mail, mentee e-mail), so a rehearsal followed by the real run
//     reports the second time as UNCHANGED instead of writing everything twice.

import { headerIndex, parseDelimited, type ParsedRow, type ParsedTable, type ValidatedRow } from '@/lib/importPreview';
import { INTERACTION_TYPES, type InteractionType } from '@/lib/interactionTypes';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { transliterate } from '@/lib/transliterate';

export const SHEETS = ['people', 'pairs', 'stageHistory', 'interactions'] as const;
export type Sheet = (typeof SHEETS)[number];

/** Our fields per sheet; `required` must be mapped (or named so in the header). */
export const SHEET_FIELDS: Record<Sheet, { field: string; required: boolean }[]> = {
  people: [
    { field: 'email', required: true },
    { field: 'fullName', required: false },
    { field: 'role', required: true },
    { field: 'phone', required: false },
    { field: 'university', required: false },
    { field: 'department', required: false },
  ],
  pairs: [
    { field: 'mentorEmail', required: true },
    { field: 'menteeEmail', required: true },
    { field: 'status', required: false },
    { field: 'startDate', required: false },
  ],
  stageHistory: [
    { field: 'mentorEmail', required: true },
    { field: 'menteeEmail', required: true },
    { field: 'fromStage', required: false },
    { field: 'toStage', required: true },
    { field: 'date', required: true },
  ],
  interactions: [
    { field: 'mentorEmail', required: true },
    { field: 'menteeEmail', required: true },
    { field: 'date', required: true },
    { field: 'type', required: true },
    { field: 'subject', required: false },
    { field: 'notes', required: true },
  ],
};

export type ColumnMapping = Partial<Record<string, string>>;

/**
 * Parse a sheet and put its values in OUR field order. A field is found by the
 * column the mapping names, else by a column named like the field itself; a
 * field with neither is empty (and, if required, every row says so).
 */
export function mappedTable(sheet: Sheet, text: string, mapping: ColumnMapping = {}): ParsedTable & { missing: string[] } {
  const raw = parseDelimited(text);
  const fields = SHEET_FIELDS[sheet];
  const index = fields.map(({ field }) => {
    const named = mapping[field];
    const byMapping = named ? headerIndex(raw.header, named) : -1;
    return byMapping >= 0 ? byMapping : headerIndex(raw.header, field);
  });
  return {
    header: fields.map((f) => f.field),
    rows: raw.rows.map((r) => ({ row: r.row, values: index.map((at) => (at >= 0 ? (r.values[at] ?? '').trim() : '')) })),
    delimiter: raw.delimiter,
    missing: fields.filter((f, i) => f.required && index[i] < 0).map((f) => f.field),
  };
}

const valuesOf = (sheet: Sheet, row: ParsedRow): Record<string, string> =>
  Object.fromEntries(SHEET_FIELDS[sheet].map((f, i) => [f.field, row.values[i] ?? '']));

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const normEmail = (e: string) => e.trim().toLowerCase();
export const pairKey = (mentorEmail: string, menteeEmail: string) => `${normEmail(mentorEmail)}|${normEmail(menteeEmail)}`;

function emailProblem(value: string, field: string): string | null {
  if (!value || !EMAIL_RE.test(value)) return `invalid ${field}`;
  if (value.length > TEXT_LIMITS.userEmail) return `${field} too long`;
  return null;
}

/**
 * A date the importer accepts: ISO (2026-03-01, 2026-03-01T10:00Z) or the
 * day-first form a German/Turkish export writes (01.03.2026). Anything else is
 * not guessed at — 03/04/2026 means two different days on two continents.
 */
export function parseSourceDate(value: string): Date | null {
  const v = value.trim();
  if (!v) return null;
  const dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v);
  const d = dotted ? new Date(Date.UTC(+dotted[3], +dotted[2] - 1, +dotted[1])) : /^\d{4}-\d{2}-\d{2}/.test(v) ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  if (dotted && (d.getUTCDate() !== +dotted[1] || d.getUTCMonth() !== +dotted[2] - 1)) return null; // 31.02.
  return d;
}

// ── People ───────────────────────────────────────────────────────────────────

export type MigrantRole = 'MENTOR' | 'MENTEE';
const ROLE_WORDS: Record<string, MigrantRole> = { mentor: 'MENTOR', mentör: 'MENTOR', mentee: 'MENTEE', intern: 'MENTEE', stajyer: 'MENTEE', praktikant: 'MENTEE', praktikantin: 'MENTEE' };

export interface PersonRow {
  email: string;
  fullName: string;
  role: MigrantRole;
  phone: string | null;
  university: string | null;
  department: string | null;
}

export function validatePerson(row: ParsedRow): ValidatedRow<PersonRow> {
  const v = valuesOf('people', row);
  const fail = (reason: string): ValidatedRow<PersonRow> => ({ ok: false, row: row.row, key: v.email, status: 'ERROR', reason });
  const bad = emailProblem(v.email, 'email');
  if (bad) return fail(bad);
  const role = ROLE_WORDS[v.role.trim().toLowerCase()];
  if (!role) return fail(v.role ? `unknown role "${v.role.slice(0, 40)}"` : 'role missing');
  for (const [field, max] of [['fullName', TEXT_LIMITS.userFullName], ['phone', TEXT_LIMITS.userPhone], ['university', TEXT_LIMITS.profileShortText], ['department', TEXT_LIMITS.profileShortText]] as const) {
    if (v[field].length > max) return fail(`${field} too long (max ${max})`);
  }
  const email = normEmail(v.email);
  return {
    ok: true,
    row: row.row,
    key: email,
    value: { email, fullName: v.fullName || email.split('@')[0], role, phone: v.phone || null, university: v.university || null, department: v.department || null },
  };
}

// ── Pairs ────────────────────────────────────────────────────────────────────

export interface PairRow {
  mentorEmail: string;
  menteeEmail: string;
  status: 'ACTIVE' | 'COMPLETED';
  startDate: Date | null;
}

const STATUS_WORDS: Record<string, PairRow['status']> = { '': 'ACTIVE', active: 'ACTIVE', aktif: 'ACTIVE', aktiv: 'ACTIVE', completed: 'COMPLETED', done: 'COMPLETED', tamamlandı: 'COMPLETED', abgeschlossen: 'COMPLETED' };

export function validatePair(row: ParsedRow, now: Date): ValidatedRow<PairRow> {
  const v = valuesOf('pairs', row);
  const key = pairKey(v.mentorEmail, v.menteeEmail);
  const fail = (reason: string): ValidatedRow<PairRow> => ({ ok: false, row: row.row, key, status: 'ERROR', reason });
  const bad = emailProblem(v.mentorEmail, 'mentorEmail') ?? emailProblem(v.menteeEmail, 'menteeEmail');
  if (bad) return fail(bad);
  if (normEmail(v.mentorEmail) === normEmail(v.menteeEmail)) return fail('mentor and mentee are the same person');
  const status = STATUS_WORDS[v.status.trim().toLowerCase()];
  if (!status) return fail(`unknown status "${v.status.slice(0, 40)}"`);
  const startDate = v.startDate ? parseSourceDate(v.startDate) : null;
  if (v.startDate && !startDate) return fail('unreadable startDate');
  if (startDate && startDate > now) return fail('startDate is in the future');
  return { ok: true, row: row.row, key, value: { mentorEmail: normEmail(v.mentorEmail), menteeEmail: normEmail(v.menteeEmail), status, startDate } };
}

// ── Stages ───────────────────────────────────────────────────────────────────

export type StageMap = Partial<Record<string, string>>;

/**
 * A source stage as one of ours: the admin's explicit mapping first, then an
 * exact key of the org's pipeline (an export from this product names its own
 * keys). Anything else is null — the caller reports it, never defaults it.
 * Matching is case- and space-insensitive on the source side only.
 */
export function translateStage(source: string, stageMap: StageMap, stageKeys: ReadonlySet<string>): string | null {
  const s = source.trim();
  if (!s) return null;
  const wanted = s.toLowerCase().replace(/\s+/g, ' ');
  for (const [from, to] of Object.entries(stageMap)) {
    if (to && from.trim().toLowerCase().replace(/\s+/g, ' ') === wanted) return stageKeys.has(to) ? to : null;
  }
  return stageKeys.has(s) ? s : null;
}

/** Targets of a stageMap that are not stages of this org — refused before anything is planned. */
export function invalidStageTargets(stageMap: StageMap, stageKeys: ReadonlySet<string>): string[] {
  return [...new Set(Object.values(stageMap).filter((to): to is string => !!to && !stageKeys.has(to)))];
}

export interface HistoryRow {
  pair: string;
  mentorEmail: string;
  menteeEmail: string;
  /** Null when the export did not say — derived from the previous row. */
  fromStage: string | null;
  toStage: string;
  at: Date;
}

export function validateHistory(row: ParsedRow, stageMap: StageMap, stageKeys: ReadonlySet<string>, now: Date): ValidatedRow<HistoryRow> {
  const v = valuesOf('stageHistory', row);
  const key = pairKey(v.mentorEmail, v.menteeEmail);
  const fail = (reason: string): ValidatedRow<HistoryRow> => ({ ok: false, row: row.row, key, status: 'ERROR', reason });
  const bad = emailProblem(v.mentorEmail, 'mentorEmail') ?? emailProblem(v.menteeEmail, 'menteeEmail');
  if (bad) return fail(bad);
  const toStage = translateStage(v.toStage, stageMap, stageKeys);
  if (!toStage) return fail(v.toStage ? `unmapped stage "${v.toStage.slice(0, 60)}"` : 'toStage missing');
  let fromStage: string | null = null;
  if (v.fromStage) {
    fromStage = translateStage(v.fromStage, stageMap, stageKeys);
    if (!fromStage) return fail(`unmapped stage "${v.fromStage.slice(0, 60)}"`);
  }
  const at = parseSourceDate(v.date);
  if (!at) return fail(v.date ? 'unreadable date' : 'date missing');
  if (at > now) return fail('date is in the future');
  if (fromStage === toStage) return fail('from and to are the same stage');
  return { ok: true, row: row.row, key, value: { pair: key, mentorEmail: normEmail(v.mentorEmail), menteeEmail: normEmail(v.menteeEmail), fromStage, toStage, at } };
}

export interface OrderedMove {
  row: number;
  fromStage: string;
  toStage: string;
  at: Date;
}

/**
 * One pair's history in time order, every `from` filled in: an explicit one is
 * kept, a missing one is the previous row's `to` (the first row's is the
 * stage the pair stood in before — its current stage, or the start stage for a
 * new pair). A row that would then go from X to X is returned as rejected,
 * and the chain continues from where it stood. `final` is the last `to`.
 */
export function orderHistory(
  rows: { row: number; value: HistoryRow }[],
  startingStage: string,
): { moves: OrderedMove[]; rejected: { row: number; reason: string }[]; final: string } {
  const sorted = [...rows].sort((a, b) => a.value.at.getTime() - b.value.at.getTime() || a.row - b.row);
  const moves: OrderedMove[] = [];
  const rejected: { row: number; reason: string }[] = [];
  let current = startingStage;
  for (const { row, value } of sorted) {
    const from = value.fromStage ?? current;
    if (from === value.toStage) {
      rejected.push({ row, reason: 'from and to are the same stage' });
      continue;
    }
    moves.push({ row, fromStage: from, toStage: value.toStage, at: value.at });
    current = value.toStage;
  }
  return { moves, rejected, final: current };
}

// ── Interactions ─────────────────────────────────────────────────────────────

export interface InteractionRow {
  pair: string;
  mentorEmail: string;
  menteeEmail: string;
  at: Date;
  type: InteractionType;
  subject: string | null;
  notes: string;
}

const TYPE_WORDS: Record<string, InteractionType> = {
  ...Object.fromEntries(INTERACTION_TYPES.map((t) => [t.toLowerCase(), t])),
  session: 'Meeting', görüşme: 'Meeting', toplantı: 'Meeting', treffen: 'Meeting', gespräch: 'Meeting',
  'e-mail': 'Email', mail: 'Email', 'e-posta': 'Email', phone: 'Call', telefon: 'Call', anruf: 'Call',
  'geri bildirim': 'Feedback', rückmeldung: 'Feedback',
};

export function validateInteraction(row: ParsedRow, now: Date): ValidatedRow<InteractionRow> {
  const v = valuesOf('interactions', row);
  const key = pairKey(v.mentorEmail, v.menteeEmail);
  const fail = (reason: string): ValidatedRow<InteractionRow> => ({ ok: false, row: row.row, key, status: 'ERROR', reason });
  const bad = emailProblem(v.mentorEmail, 'mentorEmail') ?? emailProblem(v.menteeEmail, 'menteeEmail');
  if (bad) return fail(bad);
  const at = parseSourceDate(v.date);
  if (!at) return fail(v.date ? 'unreadable date' : 'date missing');
  if (at > now) return fail('date is in the future');
  const type = TYPE_WORDS[v.type.trim().toLowerCase()];
  if (!type) return fail(v.type ? `unknown type "${v.type.slice(0, 40)}"` : 'type missing');
  if (!v.notes) return fail('notes missing');
  if (v.notes.length > TEXT_LIMITS.interactionNotes) return fail(`notes too long (max ${TEXT_LIMITS.interactionNotes})`);
  if (v.subject.length > TEXT_LIMITS.interactionSubject) return fail(`subject too long (max ${TEXT_LIMITS.interactionSubject})`);
  return { ok: true, row: row.row, key, value: { pair: key, mentorEmail: normEmail(v.mentorEmail), menteeEmail: normEmail(v.menteeEmail), at, type, subject: v.subject || null, notes: v.notes } };
}

/** The identity of an interaction for a re-run: the pair, the moment, the type and the text. */
export const interactionKey = (relationKey: string, at: Date, type: string, notes: string) => `${relationKey}|${at.toISOString()}|${type}|${notes}`;

// ── Proposing a mapping ──────────────────────────────────────────────────────

const norm = (s: string) => transliterate(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The words an incumbent's export uses for each of our fields, in the three
 * languages we sell in. A proposal only — the admin corrects it before the
 * preview, and nothing about it is stored.
 */
const FIELD_SYNONYMS: Record<string, string[]> = {
  email: ['email', 'e-mail', 'mail', 'eposta', 'e-posta', 'emailaddress', 'mailadresse'],
  fullName: ['fullname', 'name', 'full name', 'adsoyad', 'ad soyad', 'isim', 'vollstandigername', 'vorname nachname'],
  role: ['role', 'rolle', 'rol', 'type', 'usertype'],
  phone: ['phone', 'telefon', 'tel', 'mobile', 'handy', 'cep'],
  university: ['university', 'universitat', 'universite', 'school', 'hochschule', 'okul'],
  department: ['department', 'bolum', 'abteilung', 'fachbereich', 'studiengang', 'major'],
  mentorEmail: ['mentoremail', 'mentor', 'mentormail', 'mentore-mail', 'betreuer', 'mentoreposta'],
  menteeEmail: ['menteeemail', 'mentee', 'intern', 'stajyer', 'praktikant', 'menteemail', 'internemail', 'student'],
  status: ['status', 'state', 'durum', 'zustand'],
  startDate: ['startdate', 'start', 'started', 'baslangic', 'beginn', 'startdatum'],
  fromStage: ['fromstage', 'from', 'previousstage', 'oncekiasama', 'vorherigephase', 'von'],
  toStage: ['tostage', 'stage', 'phase', 'asama', 'step', 'to', 'nach', 'newstage'],
  date: ['date', 'when', 'tarih', 'datum', 'timestamp', 'changedat', 'at'],
  type: ['type', 'kind', 'tur', 'art', 'channel', 'kanal'],
  subject: ['subject', 'topic', 'konu', 'betreff', 'title', 'baslik'],
  notes: ['notes', 'note', 'notlar', 'not', 'notiz', 'notizen', 'text', 'comment', 'description', 'aciklama'],
};

/**
 * A proposed mapping for a sheet from its header row: an exact (normalized)
 * synonym first, then a header that contains one. Each source column is
 * proposed for one field at most, in our field order.
 */
export function suggestMapping(sheet: Sheet, header: string[]): Record<string, string> {
  const columns = header.map((h) => ({ raw: h, key: norm(h) })).filter((c) => c.key);
  const taken = new Set<string>();
  const out: Record<string, string> = {};
  for (const pass of ['exact', 'contains'] as const) {
    for (const { field } of SHEET_FIELDS[sheet]) {
      if (out[field]) continue;
      const words = [norm(field), ...(FIELD_SYNONYMS[field] ?? []).map(norm)];
      const hit = columns.find((c) => !taken.has(c.raw) && (pass === 'exact' ? words.includes(c.key) : words.some((w) => w.length >= 4 && c.key.includes(w))));
      if (hit) {
        out[field] = hit.raw;
        taken.add(hit.raw);
      }
    }
  }
  return out;
}

/** The distinct source stage names a history sheet uses, through its mapping. */
export function sourceStages(text: string, mapping: ColumnMapping = {}): string[] {
  const t = mappedTable('stageHistory', text, mapping);
  const from = SHEET_FIELDS.stageHistory.findIndex((f) => f.field === 'fromStage');
  const to = SHEET_FIELDS.stageHistory.findIndex((f) => f.field === 'toStage');
  return [...new Set(t.rows.flatMap((r) => [r.values[from], r.values[to]]).filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b));
}
