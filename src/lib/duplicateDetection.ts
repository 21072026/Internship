// Duplicate-candidate detection (#841). The same student can enter through
// four doors (CSV import, self-registration, mentor manual entry, public
// application) that historically never checked each other. This module is the
// single shared detector: exact signals on normalized email/phone, fuzzy
// signals on name (+university), Turkish-character safe.
//
// Detection only — merging lives in src/lib/mergeUsers.ts, and nothing here
// ever mutates data. Server-only (imports Prisma); the pure normalizers are
// exported for unit tests.
import { prisma } from '@/lib/prisma';
import { transliterate } from '@/lib/transliterate';
import { PLACEHOLDER_EMAIL_DOMAIN } from '@/lib/menteeAccount';

// ── Pure normalizers ─────────────────────────────────────────────────────────

// Name key: transliterate FIRST (maps İ→I before any lowercasing — JS
// 'İ'.toLowerCase() yields "i" + a combining dot, two code points, which would
// break equality), then lowercase, then collapse everything non-alphanumeric.
export function normalizeNameKey(name: string): string {
  return transliterate(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// Phone key: digits only, country-code and trunk-zero stripped, compared on
// the last 10 digits ("+90 555 123 45 67", "05551234567" and "555-123-4567"
// all key to "5551234567"). Too-short values yield '' (never match).
export function normalizePhoneKey(phone: string | null | undefined): string {
  if (!phone) return '';
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length > 10 && digits.startsWith('90')) digits = digits.slice(2);
  if (digits.length > 10 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length < 7) return '';
  return digits.slice(-10);
}

// Email key: lowercased/trimmed; generated stand-ins (mentor-entered mentees
// get mentee.<slug>.<hex>@import.local, erased accounts erased-<id>@erased.local)
// carry no identity and must never match anything.
export function normalizeEmailKey(email: string | null | undefined): string {
  if (!email) return '';
  const key = email.trim().toLowerCase();
  if (key.endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`) || key.endsWith('@erased.local')) return '';
  return key;
}

// Bounded Levenshtein — bails out early once the distance exceeds `max`.
export function levenshtein(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[n];
}

// ── Matching ─────────────────────────────────────────────────────────────────

export type DuplicateSignal = 'email' | 'phone' | 'name' | 'nameFuzzy' | 'university';

export interface DuplicateInput {
  fullName: string;
  email?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  university?: string | null;
}

export interface CandidateRecord {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  whatsapp: string | null;
  university: string | null;
  createdAt: Date;
  isActive: boolean;
}

export interface DuplicateMatch extends CandidateRecord {
  signals: DuplicateSignal[];
  score: number;
}

const SCORE: Record<DuplicateSignal, number> = {
  email: 100,
  phone: 80,
  name: 45,
  nameFuzzy: 30,
  university: 25,
};

// A match must reach this score to be reported. A lone university match (25)
// or a lone fuzzy-name hit on a short name never qualifies by itself.
export const DUPLICATE_SCORE_THRESHOLD = 45;

// Compare one input against one existing record. Exported for tests.
export function matchSignals(input: DuplicateInput, other: CandidateRecord): DuplicateSignal[] {
  const signals: DuplicateSignal[] = [];
  const emailKey = normalizeEmailKey(input.email);
  if (emailKey && emailKey === normalizeEmailKey(other.email)) signals.push('email');

  const inputPhones = [normalizePhoneKey(input.phone), normalizePhoneKey(input.whatsapp)].filter(Boolean);
  const otherPhones = [normalizePhoneKey(other.phone), normalizePhoneKey(other.whatsapp)].filter(Boolean);
  if (inputPhones.some((p) => otherPhones.includes(p))) signals.push('phone');

  const nameA = normalizeNameKey(input.fullName);
  const nameB = normalizeNameKey(other.fullName);
  if (nameA && nameA === nameB) {
    signals.push('name');
  } else if (nameA.length >= 6 && nameB.length >= 6 && levenshtein(nameA, nameB, 2) <= 2) {
    signals.push('nameFuzzy');
  }

  if ((signals.includes('name') || signals.includes('nameFuzzy')) && input.university && other.university) {
    if (normalizeNameKey(input.university) === normalizeNameKey(other.university)) signals.push('university');
  }
  return signals;
}

export function scoreSignals(signals: DuplicateSignal[]): number {
  return signals.reduce((sum, s) => sum + SCORE[s], 0);
}

const CANDIDATE_SELECT = {
  id: true,
  fullName: true,
  email: true,
  phone: true,
  whatsapp: true,
  university: true,
  createdAt: true,
  isActive: true,
} as const;

// Possible duplicates of `input` among the org's MENTEEs. Used by the creation
// paths (pre-flight / report-only) and by the admin check endpoint. Org-scoped:
// records from other tenants are never compared (null org matches null org).
export async function findPossibleDuplicates(
  input: DuplicateInput & { orgId: string | null; excludeId?: string },
): Promise<DuplicateMatch[]> {
  const candidates = await prisma.user.findMany({
    where: {
      role: 'MENTEE',
      orgId: input.orgId,
      ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
    },
    select: CANDIDATE_SELECT,
  });
  const matches: DuplicateMatch[] = [];
  for (const other of candidates) {
    const signals = matchSignals(input, other);
    const score = scoreSignals(signals);
    if (score >= DUPLICATE_SCORE_THRESHOLD) matches.push({ ...other, signals, score });
  }
  return matches.sort((a, b) => b.score - a.score).slice(0, 10);
}

export interface DuplicatePair {
  a: CandidateRecord;
  b: CandidateRecord;
  signals: DuplicateSignal[];
  score: number;
}

// One-time/bulk scan: every suspicious MENTEE pair in the org, strongest first.
// O(n²) over the org's mentees with cheap early-outs — fine at the hundreds
// scale this app runs at; capped so a pathological org can't flood the UI.
export async function scanDuplicatePairs(orgId: string | null, cap = 200): Promise<DuplicatePair[]> {
  const users = await prisma.user.findMany({
    where: { role: 'MENTEE', orgId },
    select: CANDIDATE_SELECT,
    orderBy: { createdAt: 'asc' },
  });
  const pairs: DuplicatePair[] = [];
  for (let i = 0; i < users.length; i++) {
    for (let j = i + 1; j < users.length; j++) {
      const signals = matchSignals(users[i], users[j]);
      const score = scoreSignals(signals);
      if (score >= DUPLICATE_SCORE_THRESHOLD) pairs.push({ a: users[i], b: users[j], signals, score });
    }
  }
  return pairs.sort((x, y) => y.score - x.score).slice(0, cap);
}
