// The admin CSV import's row rules (#1432) — pure, so the dry run and the real
// run cannot decide by different rules again, and so a unit test can throw
// every malformed file at it without a database.
//
// What went wrong before: the route checked only the e-mail, so a 250-character
// name passed the dry run ("will create 1") and then died in the INSERT with
// Prisma P2000 — an empty 500, with every row before it already written and
// none after. Every length here is the column's (TEXT_LIMITS), and a row that
// breaks one is REPORTED, never thrown.

import { TEXT_LIMITS } from './textLimits';

export interface ImportRow {
  /** 1-based, counted after the header — the number the report shows. */
  row: number;
  fullName: string;
  email: string;
  phone: string;
  university: string;
  department: string;
}

export type RowStatus = 'create' | 'skip' | 'error';

export interface RowPlan {
  row: number;
  email: string;
  status: RowStatus;
  reason?: string;
  /** What will be written, for a `create` row only. */
  data?: { email: string; fullName: string; phone: string | null; university: string | null; department: string | null };
}

/** Split a CSV line honoring simple double-quoted fields ("a, b" and "" escapes). */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Columns: fullName,email[,phone,university,department]. A first line naming
 * an `email` column is a header and is dropped. A UTF-8 BOM (what Excel puts
 * in front of a "CSV UTF-8" save) and blank lines are ignored.
 */
export function parseImportCsv(csv: string): ImportRow[] {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length && parseCsvLine(lines[0]).some((cell) => cell.toLowerCase() === 'email')) lines.shift();
  return lines.map((line, i) => {
    const [fullName = '', email = '', phone = '', university = '', department = ''] = parseCsvLine(line);
    return { row: i + 1, fullName, email, phone, university, department };
  });
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

/**
 * The verdict for every row. `taken` holds the lower-cased addresses that
 * already have an account in the importing admin's world (#2590). A second
 * occurrence of an address inside the same file is skipped like an existing
 * one — the dry run used to promise both.
 */
export function planImport(rows: ImportRow[], taken: ReadonlySet<string>): RowPlan[] {
  const seen = new Set<string>();
  return rows.map((r) => {
    const problem = rowProblem(r);
    if (problem) return { row: r.row, email: r.email, status: 'error', reason: problem };
    const email = r.email.toLowerCase();
    if (taken.has(email)) return { row: r.row, email: r.email, status: 'skip', reason: 'already exists' };
    if (seen.has(email)) return { row: r.row, email: r.email, status: 'skip', reason: 'duplicate in file' };
    seen.add(email);
    return {
      row: r.row,
      email: r.email,
      status: 'create',
      data: {
        email,
        fullName: r.fullName || email.split('@')[0],
        phone: r.phone || null,
        university: r.university || null,
        department: r.department || null,
      },
    };
  });
}
