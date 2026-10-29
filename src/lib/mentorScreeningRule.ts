// The screening record on a mentor application (#1807) — the pure half: the
// checklist vocabulary, how a stored checklist is read, the org's "required
// before approval" policy and what is still missing. Dependency-free so the
// browser (the panel, the queue badge) and the server (the approve handler,
// which is the ONLY enforcement) read the same rule. Unit-tested in
// scripts/test/mentor-screening.test.mjs.
//
// The checklist is a RECORD of what was done, not a workflow: every item is
// optional unless the org's `mentorScreeningRequired` setting names it, and the
// default (empty) leaves approval exactly as it was before #1807. Nothing here
// ever reaches the applicant.

export const SCREENING_ITEMS = ['referencesChecked', 'identityVerified', 'expertiseVerified', 'interviewDone', 'backgroundOk'] as const;
export type ScreeningItem = (typeof SCREENING_ITEMS)[number];

export interface ChecklistEntry {
  done: boolean;
  /** User id of the admin who last ticked or unticked it. */
  by: string;
  /** ISO instant of that change. */
  at: string;
}

export type ScreeningChecklist = Partial<Record<ScreeningItem, ChecklistEntry>>;

export function isScreeningItem(value: unknown): value is ScreeningItem {
  return typeof value === 'string' && (SCREENING_ITEMS as readonly string[]).includes(value);
}

/** A stored Json column → a checklist. Unknown keys and malformed entries are dropped, never trusted. */
export function parseChecklist(raw: unknown): ScreeningChecklist {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: ScreeningChecklist = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isScreeningItem(key) || !value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    if (typeof v.done !== 'boolean' || typeof v.by !== 'string' || typeof v.at !== 'string') continue;
    out[key] = { done: v.done, by: v.by, at: v.at };
  }
  return out;
}

/** The checklist with one item stamped by `by` at `at`. */
export function stampItem(checklist: ScreeningChecklist, item: ScreeningItem, done: boolean, by: string, at: Date): ScreeningChecklist {
  return { ...checklist, [item]: { done, by, at: at.toISOString() } };
}

/** The `mentorScreeningRequired` setting (comma-separated item keys) → the required items, in vocabulary order. */
export function parseRequired(raw: string | null | undefined): ScreeningItem[] {
  const named = new Set((raw ?? '').split(',').map((s) => s.trim()));
  return SCREENING_ITEMS.filter((i) => named.has(i));
}

export function serializeRequired(items: readonly string[]): string {
  return parseRequired(items.join(',')).join(',');
}

/** Required items not marked done — what an approval would be refused for. Empty = may approve. */
export function missingRequired(checklist: ScreeningChecklist, required: readonly ScreeningItem[]): ScreeningItem[] {
  return required.filter((i) => checklist[i]?.done !== true);
}

/** How far the screening got, for the queue badge. */
export function screeningProgress(checklist: ScreeningChecklist, required: readonly ScreeningItem[]): { done: number; total: number; ready: boolean } {
  return {
    done: SCREENING_ITEMS.filter((i) => checklist[i]?.done === true).length,
    total: SCREENING_ITEMS.length,
    ready: missingRequired(checklist, required).length === 0,
  };
}
