import { wrapUntrusted } from '@/lib/ai/untrusted';
import { visibleGoals, type GoalRelationSeats, type GoalScope, type GoalViewer } from '@/lib/goalVisibilityRule';

// The dependency-free half of the personalised session agenda (#1845): what
// leaves the process, and how the model's answer becomes agenda lines. No
// Prisma, no SDK — `scripts/test/ai-agenda.test.mjs` loads this file under
// `node --test` and asserts the outbound text against it.
//
// WHAT GOES OUT, and only this: the guide's title and prompts (library text),
// the lines already on the agenda, the open goals the CALLER may read (titles,
// success criteria, progress — the goal visibility rule decides, so another
// seat's PRIVATE goal never rides along), the previous session's lines with
// their done state, the newest interaction log entries (date, type, subject,
// notes — contact details masked by callModel, #2026) and the stage label.
// WHAT NEVER GOES OUT: names, e-mail addresses, CVs, documents, attachments,
// the company's contact data. The builder takes the already-selected fields
// and reads nothing else from the objects it is given.

/** How many lines one proposal holds: the model is asked for 4–7, the cap is the ceiling. */
export const AGENDA_PROPOSAL_MIN = 4;
export const AGENDA_PROPOSAL_MAX = 7;
/** One proposed line is a prompt, not a paragraph. */
export const AGENDA_PROPOSAL_LINE_MAX = 200;
/** The newest log entries that go out — the same window a summary of a pair reads from, cut short. */
export const AGENDA_LOG_ENTRIES = 3;

export interface AgendaGoalInput extends GoalScope {
  title: string;
  successCriteria: string | null;
  progress: number | null;
}

export interface AgendaLogEntry {
  date: Date;
  type: string;
  subject: string | null;
  notes: string;
}

export interface AgendaPreviousLine {
  text: string;
  done: boolean;
}

export interface AgendaPayloadInput {
  /** `en` / `tr` / `de` — the language the proposal is written in. */
  locale: string;
  /** The stage label the caller sees, in their locale. */
  stageLabel: string;
  /** The guide being adapted — its title and prompts in the caller's locale; null for a free-form agenda. */
  guide: { title: string; prompts: string[] } | null;
  /** What is already on this agenda, resolved in the caller's locale. */
  existingLines: string[];
  /** The previous session's lines, with whether they were discussed. */
  previousLines: AgendaPreviousLine[];
  /** Every open goal of the pair; the rule below keeps the ones this viewer may read. */
  goals: AgendaGoalInput[];
  /** The newest log entries, newest first. */
  log: AgendaLogEntry[];
  rel: GoalRelationSeats;
  viewer: GoalViewer;
}

/** The goals that may leave the process for THIS viewer (the route-level rule, #1858). */
export function agendaGoalsFor<T extends AgendaGoalInput>(goals: readonly T[], rel: GoalRelationSeats, viewer: GoalViewer): T[] {
  return visibleGoals(goals, rel, viewer);
}

/** True when there is nothing specific to adapt to — the model would only restate a generic guide. */
export function agendaHasContext(input: Pick<AgendaPayloadInput, 'guide' | 'goals' | 'previousLines' | 'log' | 'rel' | 'viewer'>): boolean {
  return input.guide !== null || agendaGoalsFor(input.goals, input.rel, input.viewer).length > 0 || input.previousLines.length > 0 || input.log.length > 0;
}

/**
 * The user message of the call. Every block of person-written text is fenced
 * as untrusted data (#2026); the library text and the stage label are ours.
 */
export function buildAgendaPayload(input: AgendaPayloadInput, nonce?: string): string {
  const fence = (label: string, text: string) => (nonce ? wrapUntrusted(label, text, nonce) : wrapUntrusted(label, text));
  const goals = agendaGoalsFor(input.goals, input.rel, input.viewer);
  const parts: string[] = [`locale: ${input.locale}`, `stage: ${input.stageLabel}`];
  if (input.guide) {
    parts.push(`guide: ${input.guide.title}`);
    if (input.guide.prompts.length > 0) parts.push(`guide prompts:\n${input.guide.prompts.map((p, i) => `${i + 1}. ${p}`).join('\n')}`);
  } else {
    parts.push('guide: none (free-form agenda)');
  }
  if (input.existingLines.length > 0) {
    parts.push(`already on this agenda (do not repeat):\n${fence('agenda', input.existingLines.map((l) => `- ${l}`).join('\n'))}`);
  }
  if (goals.length > 0) {
    const text = goals
      .map((g) => {
        const progress = typeof g.progress === 'number' ? ` (${g.progress}%)` : '';
        return `- ${g.title}${progress}${g.successCriteria ? `\n  success: ${g.successCriteria}` : ''}`;
      })
      .join('\n');
    parts.push(`open goals:\n${fence('goals', text)}`);
  }
  if (input.previousLines.length > 0) {
    const text = input.previousLines.map((l) => `- [${l.done ? 'discussed' : 'open'}] ${l.text}`).join('\n');
    parts.push(`previous session:\n${fence('previous', text)}`);
  }
  if (input.log.length > 0) {
    const text = input.log
      .slice(0, AGENDA_LOG_ENTRIES)
      .map((e) => `${e.date.toISOString().slice(0, 10)} · ${e.type}${e.subject ? ` · ${e.subject}` : ''}\n${e.notes}`)
      .join('\n---\n');
    parts.push(`newest log entries (newest first):\n${fence('log', text)}`);
  }
  return parts.join('\n\n');
}

/** One line as it may enter an agenda: single-spaced, trimmed, bounded. */
function cleanLine(raw: unknown): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, AGENDA_PROPOSAL_LINE_MAX);
}

/**
 * The model's lines as a proposal: deduplicated (case-insensitively), the
 * ones already on the agenda dropped, at most AGENDA_PROPOSAL_MAX kept, in
 * the model's order.
 */
export function normalizeAgendaProposal(raw: unknown, existingLines: readonly string[]): string[] {
  const seen = new Set(existingLines.map((l) => cleanLine(l).toLowerCase()).filter(Boolean));
  const out: string[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (typeof item !== 'string') continue;
    const line = cleanLine(item);
    const key = line.toLowerCase();
    if (!line || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length === AGENDA_PROPOSAL_MAX) break;
  }
  return out;
}

/**
 * The honest fallback (#1845): when the model cannot be asked — no consent,
 * no provider, no quota, a provider error — the answer is the guide as
 * written, minus the lines already on the agenda. Never an upgrade prompt,
 * never an error page, never an empty answer while the guide has lines.
 */
export function templateFallback(guidePrompts: readonly string[], existingLines: readonly string[]): string[] {
  return normalizeAgendaProposal([...guidePrompts], existingLines);
}
