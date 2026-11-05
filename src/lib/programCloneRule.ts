// Clone a programme for the next intake (#1643) — the pure half, client-safe.
//
// A clone copies CONFIGURATION and nothing that identifies a person. What
// counts as configuration is decided here, row by row, so the route only
// reads and writes:
//
//   copied   the programme's own scalars (name/term given by the caller,
//            eligibilityMode), its stage SLA overrides that name no mentor,
//            its eligibility rules, its journey steps that are not archived,
//            and its per-programme settings (through the settings writer).
//   never    relations, members, mentor assignments, admin scope grants,
//            match rounds, programme costs, programme events (each has a host
//            and seats taken), step runs, and any SLA row that names a mentor
//            — a per-mentor override describes a person, not the programme.
//
// The new programme starts with no participants, so it is inert until an
// admin adds people to it; there is no separate DRAFT state on Cohort yet
// (#1622 adds the lifecycle column).

import { slaScopeKey } from './stageSlaRule';

/** The tables a clone writes, and the ones it must never touch (the e2e spec asserts the second list). */
export const CLONED_CONFIG = ['Cohort', 'StageSla', 'ProgramEligibilityRule', 'ProgramStep', 'Setting'] as const;
export const NEVER_CLONED = [
  'MentorshipRelation',
  'AdminScopeGrant',
  'MatchRound',
  'ProgramCost',
  'ProgramEvent',
  'ProgramStepRun',
] as const;

const YEAR = /\b(19|20)\d{2}\b/;

/**
 * The term of the next intake: the year in the term moved one on
 * ("2026 Spring" → "2027 Spring"). A range moves both ends ("WS 2025/26" →
 * "WS 2026/27"). No year: the term comes back unchanged and the admin edits it.
 */
export function nextTerm(term: string | null | undefined): string {
  const t = (term ?? '').trim();
  if (!t) return '';
  const range = /\b((?:19|20)\d{2})\s*([/-])\s*((?:19|20)?\d{2})\b/.exec(t);
  if (range) {
    const a = Number(range[1]);
    const bRaw = range[3];
    const b = bRaw.length === 2 ? `${String((Number(bRaw) + 1) % 100).padStart(2, '0')}` : String(Number(bRaw) + 1);
    return t.replace(range[0], `${a + 1}${range[2]}${b}`);
  }
  const m = YEAR.exec(t);
  if (!m) return t;
  return t.replace(m[0], String(Number(m[0]) + 1));
}

/** The name the dialog suggests: the source name with its year moved on, else "<name> (next)". */
export function suggestCloneName(name: string, nextLabel: string): string {
  const n = name.trim();
  const moved = nextTerm(n);
  if (moved && moved !== n) return moved.slice(0, 120);
  return `${n} (${nextLabel})`.slice(0, 120);
}

export interface SourceSlaRow {
  stageKey: string;
  days: number | null;
  wipLimit: number | null;
  escalateAfterDays: number | null;
  cohortId: string | null;
  mentorId: string | null;
}

/** The source programme's SLA overrides re-keyed to the clone. A row that names a mentor is dropped. */
export function cloneSlaRows(rows: readonly SourceSlaRow[], orgId: string, programId: string) {
  return rows
    .filter((r) => !r.mentorId)
    .map((r) => ({
      orgId,
      stageKey: r.stageKey,
      days: r.days,
      wipLimit: r.wipLimit,
      escalateAfterDays: r.escalateAfterDays,
      cohortId: programId,
      mentorId: null,
      scope: slaScopeKey({ cohortId: programId, mentorId: null }),
    }));
}

export interface SourceEligibilityRule {
  effect: string;
  attribute: string;
  operator: string;
  value: unknown;
  priority: number;
  active: boolean;
  appliesTo: string;
}

/** The source programme's eligibility rules for the clone, authored by whoever cloned them. */
export function cloneEligibilityRules(rows: readonly SourceEligibilityRule[], orgId: string, programId: string, actorId: string) {
  return rows.map((r) => ({
    orgId,
    programId,
    effect: r.effect,
    attribute: r.attribute,
    operator: r.operator,
    value: r.value,
    priority: r.priority,
    active: r.active,
    appliesTo: r.appliesTo,
    createdById: actorId,
  }));
}

export interface SourceStep {
  order: number;
  milestone: string | null;
  anchor: string;
  offsetDays: number;
  audience: string;
  action: string;
  payload: unknown;
  title: string;
  translations: unknown;
  publishedAt: Date | null;
  archivedAt: Date | null;
}

/** The journey for the clone: archived steps stay behind, the rest keep their order and published state. */
export function cloneSteps(rows: readonly SourceStep[], orgId: string, programId: string) {
  return rows
    .filter((s) => !s.archivedAt)
    .map((s) => ({
      orgId,
      programId,
      order: s.order,
      milestone: s.milestone,
      anchor: s.anchor,
      offsetDays: s.offsetDays,
      audience: s.audience,
      action: s.action,
      payload: s.payload,
      title: s.title,
      translations: s.translations,
      publishedAt: s.publishedAt,
    }));
}
