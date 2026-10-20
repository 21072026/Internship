// The program journey rule (#1852) — what a ProgramStep is, when it falls due
// for a relation, and whether it is already satisfied. Pure and
// dependency-free on purpose: the daily sweep (src/lib/programJourney.ts), the
// journey builder's timeline preview (#1853) and the participant view (#1855)
// all answer "when is this step due" through these functions, so the preview
// cannot promise a date the sweep would not keep.
//
// RULES THIS FILE IS BUILT AROUND:
//   • THE VOCABULARIES ARE WHITELISTS. anchor, audience, action and the skip
//     conditions are free Strings in the schema (repo convention, see
//     src/lib/dropoffReasons.ts); anything outside these lists is refused on
//     write and ignored on read.
//   • NO BACKFILL. A step whose due date is more than JOURNEY_LOOKBACK_DAYS in
//     the past is never delivered — publishing a journey on a live programme
//     must not fire six months of steps at once. The sweep does not even look
//     at such pairs, so they leave no row behind.
//   • THE TENANT'S OWN STAGES. A STAGE_ENTRY step names a stage key; when the
//     org's resolved pipeline (#747) does not have that key, the step is
//     UNRESOLVED — reported by the sweep, never silently matched against the
//     built-in default set (the weekly-report reminder's hardcoded stage is the
//     bug this avoids).
//   • A SATISFIED STEP IS RECORDED, NOT SENT. "Book the kick-off call" when a
//     meeting already exists is noise; the run row carries the reason instead.

export const JOURNEY_ANCHORS = ['RELATION_START', 'PROGRAM_START', 'STAGE_ENTRY'] as const;
export type JourneyAnchor = (typeof JOURNEY_ANCHORS)[number];

export const JOURNEY_AUDIENCES = ['MENTOR', 'MENTEE', 'BOTH'] as const;
export type JourneyAudience = (typeof JOURNEY_AUDIENCES)[number];

export const JOURNEY_ACTIONS = ['NUDGE', 'ASSIGN_TODO', 'PUBLISH_CONTENT', 'SUGGEST_AGENDA', 'GROUP_SESSION'] as const;
export type JourneyAction = (typeof JOURNEY_ACTIONS)[number];

// The observable facts a step may be skipped on — the derived-tick idea of the
// mentor onboarding checklist (src/lib/menteeOnboarding.ts), as data.
export const JOURNEY_SKIP_CONDITIONS = ['meeting_exists', 'goal_exists', 'message_exists', 'interaction_logged'] as const;
export type JourneySkipCondition = (typeof JOURNEY_SKIP_CONDITIONS)[number];

/** How late a step may still be delivered. A week covers a missed tick or a step published mid-week. */
export const JOURNEY_LOOKBACK_DAYS = 7;
/** How far an offset may reach, either side of its anchor (two years). */
export const JOURNEY_MAX_OFFSET_DAYS = 730;
/** How many steps one sweep tick may deliver; the rest wait for tomorrow's tick. */
export const JOURNEY_BATCH = 200;

const DAY = 24 * 60 * 60 * 1000;

const isIn = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
export const isJourneyAnchor = (v: unknown): v is JourneyAnchor => isIn(JOURNEY_ANCHORS, v);
export const isJourneyAudience = (v: unknown): v is JourneyAudience => isIn(JOURNEY_AUDIENCES, v);
export const isJourneyAction = (v: unknown): v is JourneyAction => isIn(JOURNEY_ACTIONS, v);
export const isJourneySkipCondition = (v: unknown): v is JourneySkipCondition => isIn(JOURNEY_SKIP_CONDITIONS, v);

export interface StepPayload {
  stageKey?: string;
  url?: string;
  agendaTemplateId?: string;
  skipIf?: JourneySkipCondition;
}

/** The payload as stored, narrowed to its known keys; anything malformed reads as absent. */
export function readStepPayload(value: unknown): StepPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const out: StepPayload = {};
  if (typeof raw.stageKey === 'string' && raw.stageKey.length > 0 && raw.stageKey.length <= 64) out.stageKey = raw.stageKey;
  if (typeof raw.url === 'string' && isSafeContentUrl(raw.url)) out.url = raw.url;
  if (typeof raw.agendaTemplateId === 'string' && /^[a-z0-9]{1,40}$/i.test(raw.agendaTemplateId)) out.agendaTemplateId = raw.agendaTemplateId;
  if (isJourneySkipCondition(raw.skipIf)) out.skipIf = raw.skipIf;
  return out;
}

/** A content link a step may carry: a same-app path, or an https URL without credentials. */
export function isSafeContentUrl(url: string): boolean {
  if (url.length > 500) return false;
  if (url.startsWith('/')) return !url.startsWith('//') && !url.includes('\\');
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** Who of the pair a step goes to. */
export function recipientsFor(audience: string, pair: { mentorId: string; menteeId: string }): string[] {
  if (audience === 'MENTOR') return [pair.mentorId];
  if (audience === 'MENTEE') return [pair.menteeId];
  if (audience === 'BOTH') return [pair.mentorId, pair.menteeId];
  return [];
}

export interface AnchorFacts {
  relationStart: Date;
  /** The programme's start; null until the programme carries one (#1622). */
  programStart: Date | null;
  /** When the relation entered each stage key (first entry). */
  stageEntries: ReadonlyMap<string, Date>;
}

export type DueResolution =
  | { kind: 'due'; dueAt: Date }
  | { kind: 'unresolved'; reason: 'program_has_no_start' | 'stage_not_in_pipeline' | 'stage_not_entered' | 'invalid_step' };

/**
 * When `step` falls due for a relation. `stageKeys` is the org's RESOLVED stage
 * set — a STAGE_ENTRY step whose key is not in it is unresolved, never guessed.
 */
export function resolveDueAt(
  step: { anchor: string; offsetDays: number; payload?: unknown },
  facts: AnchorFacts,
  stageKeys: ReadonlySet<string>,
): DueResolution {
  if (!isJourneyAnchor(step.anchor) || !Number.isInteger(step.offsetDays) || Math.abs(step.offsetDays) > JOURNEY_MAX_OFFSET_DAYS) {
    return { kind: 'unresolved', reason: 'invalid_step' };
  }
  let anchorAt: Date;
  if (step.anchor === 'RELATION_START') anchorAt = facts.relationStart;
  else if (step.anchor === 'PROGRAM_START') {
    if (!facts.programStart) return { kind: 'unresolved', reason: 'program_has_no_start' };
    anchorAt = facts.programStart;
  } else {
    const key = readStepPayload(step.payload).stageKey;
    if (!key) return { kind: 'unresolved', reason: 'invalid_step' };
    if (!stageKeys.has(key)) return { kind: 'unresolved', reason: 'stage_not_in_pipeline' };
    const entered = facts.stageEntries.get(key);
    if (!entered) return { kind: 'unresolved', reason: 'stage_not_entered' };
    anchorAt = entered;
  }
  return { kind: 'due', dueAt: new Date(anchorAt.getTime() + step.offsetDays * DAY) };
}

/**
 * Why a step cannot be scheduled for ANY relation of this org, or null. The
 * per-relation reasons (a stage not entered yet) are not here: those are
 * ordinary "not due", not something the admin has to fix.
 */
export function stepUnresolvable(step: { anchor: string; offsetDays: number; payload?: unknown }, stageKeys: ReadonlySet<string>): string | null {
  if (!isJourneyAnchor(step.anchor) || !Number.isInteger(step.offsetDays) || Math.abs(step.offsetDays) > JOURNEY_MAX_OFFSET_DAYS) return 'invalid_step';
  // Program.startsAt arrives with #1622; until then nothing anchors on it.
  if (step.anchor === 'PROGRAM_START') return 'program_has_no_start';
  if (step.anchor === 'STAGE_ENTRY') {
    const key = readStepPayload(step.payload).stageKey;
    if (!key) return 'invalid_step';
    if (!stageKeys.has(key)) return 'stage_not_in_pipeline';
  }
  return null;
}

/** Whether a due date may be delivered today: reached, and not older than the lookback window. */
export function isDeliverable(dueAt: Date, now: Date): boolean {
  return dueAt.getTime() <= now.getTime() && dueAt.getTime() >= now.getTime() - JOURNEY_LOOKBACK_DAYS * DAY;
}

/** Whether a step is live: published, not archived, and a valid action. */
export function isLiveStep(step: { publishedAt: Date | null; archivedAt: Date | null; action: string }, now: Date): boolean {
  return !!step.publishedAt && step.publishedAt.getTime() <= now.getTime() && !step.archivedAt && isJourneyAction(step.action);
}

export type SatisfactionFacts = Partial<Record<JourneySkipCondition, boolean>>;

/** The derived tick: the reason a step is already done, or null when it should be delivered. */
export function satisfiedReason(step: { payload?: unknown }, facts: SatisfactionFacts): string | null {
  const cond = readStepPayload(step.payload).skipIf;
  if (!cond) return null;
  return facts[cond] ? `satisfied:${cond}` : null;
}

/** The step's title in `locale`, falling back to the canonical wording. */
export function stepTitle(step: { title: string; translations?: unknown }, locale: string): string {
  const t = step.translations;
  if (t && typeof t === 'object' && !Array.isArray(t)) {
    const v = (t as Record<string, unknown>)[locale];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return step.title;
}

/** The in-app notification type each action is delivered as (notifications.events in the dictionaries). */
export function notificationTypeFor(action: JourneyAction): string {
  return `programStep.${action === 'NUDGE' ? 'nudge' : action === 'ASSIGN_TODO' ? 'todo' : action === 'PUBLISH_CONTENT' ? 'content' : action === 'SUGGEST_AGENDA' ? 'agenda' : 'groupSession'}`;
}

// ── Preview and export (#1853) ───────────────────────────────────────────────

/**
 * Where one step stands for one relation — the journey builder's dry-run
 * preview and the participant view (#1855) both read this, so the timeline an
 * admin previews is the one the sweep keeps.
 */
export type StepStatus =
  | 'delivered'   // a run was delivered
  | 'skipped'     // a run was recorded as satisfied
  | 'claimed'     // a run row without a confirmed outcome (at-most-once)
  | 'due'         // the next sweep delivers it
  | 'would_skip'  // the next sweep records it as satisfied
  | 'upcoming'    // its date is still ahead
  | 'missed'      // its date fell before the lookback window; never delivered
  | 'waiting'     // its anchor has not happened yet (a stage not entered)
  | 'unresolved'  // the org cannot schedule it at all
  | 'draft'       // not published
  | 'archived';

export interface StepTimelineEntry {
  status: StepStatus;
  dueAt: Date | null;
  reason: string | null;
}

export function journeyStepStatus(
  step: { anchor: string; offsetDays: number; payload?: unknown; publishedAt: Date | null; archivedAt: Date | null; action: string },
  run: { deliveredAt: Date | null; skippedReason: string | null; dueAt: Date } | null,
  facts: AnchorFacts,
  stageKeys: ReadonlySet<string>,
  satisfaction: SatisfactionFacts,
  now: Date,
): StepTimelineEntry {
  if (run) {
    if (run.deliveredAt) return { status: 'delivered', dueAt: run.dueAt, reason: null };
    if (run.skippedReason) return { status: 'skipped', dueAt: run.dueAt, reason: run.skippedReason };
    return { status: 'claimed', dueAt: run.dueAt, reason: null };
  }
  const unresolvable = stepUnresolvable(step, stageKeys);
  if (unresolvable) return { status: 'unresolved', dueAt: null, reason: unresolvable };
  const due = resolveDueAt(step, facts, stageKeys);
  const dueAt = due.kind === 'due' ? due.dueAt : null;
  if (step.archivedAt) return { status: 'archived', dueAt, reason: null };
  if (!step.publishedAt || !isLiveStep(step, now)) return { status: 'draft', dueAt, reason: null };
  if (due.kind !== 'due') return { status: 'waiting', dueAt: null, reason: due.reason };
  if (due.dueAt.getTime() > now.getTime()) return { status: 'upcoming', dueAt, reason: null };
  if (!isDeliverable(due.dueAt, now)) return { status: 'missed', dueAt, reason: null };
  const skip = satisfiedReason(step, satisfaction);
  return skip ? { status: 'would_skip', dueAt, reason: skip } : { status: 'due', dueAt, reason: null };
}

/** One step as a template carries it: no ids, no dates, no tenant — a clone is a data copy (#1641/#1643). */
export interface JourneyTemplateStep {
  order: number;
  milestone: string | null;
  anchor: JourneyAnchor;
  offsetDays: number;
  audience: JourneyAudience;
  action: JourneyAction;
  payload: StepPayload;
  title: string;
  translations: Partial<Record<'en' | 'tr' | 'de', string>>;
}

export function journeyTemplate(
  steps: { order: number; milestone?: string | null; anchor: string; offsetDays: number; audience: string; action: string; payload?: unknown; title: string; translations?: unknown; archivedAt?: Date | null }[],
): JourneyTemplateStep[] {
  const out: JourneyTemplateStep[] = [];
  for (const s of [...steps].sort((a, b) => a.order - b.order)) {
    if (s.archivedAt || !isJourneyAnchor(s.anchor) || !isJourneyAudience(s.audience) || !isJourneyAction(s.action)) continue;
    out.push({
      order: out.length,
      milestone: s.milestone ?? null,
      anchor: s.anchor,
      offsetDays: s.offsetDays,
      audience: s.audience,
      action: s.action,
      payload: readStepPayload(s.payload),
      title: s.title,
      translations: readStepTranslations(s.translations),
    });
  }
  return out;
}

/** The per-locale titles as stored, narrowed to en/tr/de non-empty strings. */
export function readStepTranslations(value: unknown): Partial<Record<'en' | 'tr' | 'de', string>> {
  const out: Partial<Record<'en' | 'tr' | 'de', string>> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const l of ['en', 'tr', 'de'] as const) {
    const v = (value as Record<string, unknown>)[l];
    if (typeof v === 'string' && v.trim()) out[l] = v.trim();
  }
  return out;
}
