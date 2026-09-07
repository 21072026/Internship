import { defaultPipelineStages, type ResolvedStage } from './pipeline';
import type { Locale } from '@/i18n/config';

/**
 * The curated programme template catalogue (#1641) — ready-made programme
 * shapes in EN/TR/DE.
 *
 * WHY THE SHAPES SHIP IN THE REPO
 *
 * A new organization opens the pipeline editor and faces an empty stage list.
 * Inventing a pipeline from nothing is the hardest part of the first hour, and
 * the product already knows what a graduate internship, an onboarding buddy
 * programme, a leadership cohort and a career transition actually look like.
 * So the shapes ship filled: pick one, adjust a label, apply.
 *
 * HOUSE STYLE — a new template follows these rules or it does not belong here:
 *
 *   - Five to eight stages. A stage set you cannot read in one glance is a
 *     spreadsheet, not a pipeline. The canonical thirteen-stage set is the one
 *     exception, and it is here because it is the product default, not because
 *     it is a good starting shape for everyone.
 *   - A stage is a WAITING ROOM someone can sit in, named for the state they
 *     are in — "Screening call", "Reskilling in progress" — never for the
 *     action someone else has to take. If nobody can sit in it for a day, it is
 *     an interaction log entry, not a stage.
 *   - Exactly one way in and at least one way out. Every template ends on a
 *     terminal on-path stage (the good outcome) plus one off-path stage for the
 *     people who leave — the pipeline has to be able to describe a withdrawal
 *     without lying about it.
 *   - Genuinely different shapes. A template that is the canonical set with the
 *     labels rewritten teaches nobody anything; it is a rename, and the editor
 *     already does renames.
 *   - Every label in all three languages, written in each language rather than
 *     transliterated from the English.
 *
 * KEYS ARE STABLE, LABELS ARE NOT
 *
 * A stage key is an identifier: it is what `MentorshipRelation.pipelineStatus`
 * stores, what an SLA row points at and what a saved board filter remembers.
 * It never changes and it is never translated. The label is what a human reads;
 * it is resolved per locale at apply time and an admin is free to rewrite it
 * afterwards. Keys are prefixed per template (`GRAD_`, `BUDDY_`, …) so two
 * templates never collide, and none of them reuses a canonical default key —
 * a hardcoded canonical key in src/ is what scripts/check-stage-keys.mjs
 * exists to catch (#1886), and the canonical template below derives its stages
 * from the enum instead of spelling them out.
 *
 * EDITING A TEMPLATE NEVER REWRITES A PROGRAMME THAT APPLIED IT
 *
 * Applying copies the stages into the organization's own `PipelineStage` rows.
 * There is no live link back: rewording a label here changes what the NEXT
 * organization gets, and touches nothing that already exists. Same rule as the
 * newsletter library in src/lib/newsletterContent.ts.
 *
 * THIS MODULE NEVER WRITES ANYTHING
 *
 * It is data and pure functions, deliberately Prisma-free so the wizard can
 * render the catalogue on the client without a server round-trip (the same rule
 * that keeps src/lib/pipeline.ts client-importable). The only writer of a stage
 * set is the existing editor endpoint,
 * `PUT /api/admin/organizations/[id]/pipeline-stages`, and `templateStagePayload()`
 * below produces exactly the body it accepts. That endpoint replaces the set
 * with deleteMany + createMany and remaps no relation, so applying a template
 * over a programme that is already running strands every mentee on a stage key
 * that no longer exists — read `templateApplyBlockers()` before wiring an apply
 * button to it.
 */

// The three languages every curated string ships in. Derived from an exhaustive
// Record so adding a locale to src/i18n/config.ts fails the build here rather
// than silently shipping a template with a missing language.
const LOCALE_PRESENCE: Record<Locale, true> = { en: true, tr: true, de: true };
export const TEMPLATE_LOCALES = Object.keys(LOCALE_PRESENCE) as Locale[];

/** One string in every supported language. */
export type LocalizedLabel = Record<Locale, string>;

/**
 * A stage as the catalogue stores it: a `ResolvedStage` whose single `label` is
 * replaced by one label per locale. Tying it to `ResolvedStage` is deliberate —
 * a field added to the resolved shape shows up here as a type error instead of
 * quietly shipping templates that cannot express it.
 */
export type TemplateStage = Omit<ResolvedStage, 'label'> & { labels: LocalizedLabel };

/** A service level, in calendar days (see the note on `StageSla`). */
export interface TemplateSla {
  stageKey: string;
  days: number;
}

/** A document the programme expects, optionally tied to the stage that needs it. */
export interface TemplateDocumentRequirement {
  key: string;
  labels: LocalizedLabel;
  appliesToStage?: string;
  mandatory: boolean;
}

export interface ProgramTemplate {
  /** Stable identifier. Also the i18n key of the name/description pair. */
  key: string;
  stages: TemplateStage[];
  slas: TemplateSla[];
  /** The programme's default nudge cadence, in days (`Setting.reminderDays`). */
  reminderDays: number;
  documentRequirements?: TemplateDocumentRequirement[];
}

// Stage keys are validated by the editor endpoint as /^[A-Za-z0-9_]+$/, max 60
// characters, max 50 stages per set. Mirrored here so a malformed template
// fails the catalogue test rather than a 400 at apply time.
const STAGE_KEY_RE = /^[A-Za-z0-9_]+$/;
const MAX_KEY_LENGTH = 60;
const MAX_STAGES = 50;
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// ── The catalogue ────────────────────────────────────────────────────────────

/**
 * The product's canonical thirteen stages, as a template.
 *
 * Derived from the `PipelineStatus` enum rather than retyped, so it cannot drift
 * from `defaultPipelineStages()` and so no canonical key is spelled out in this
 * file. It carries no SLAs on purpose: an SLA row has to name a stage key, and
 * naming these keys here is precisely what #1886 forbids — an organization on
 * the canonical set sets its own service levels in the SLA editor.
 */
function canonicalTemplate(): ProgramTemplate {
  const perLocale = new Map(TEMPLATE_LOCALES.map((locale) => [locale, defaultPipelineStages(locale)]));
  const base = perLocale.get('en') as ResolvedStage[];
  return {
    key: 'canonical_pipeline',
    stages: base.map((stage, i) => ({
      key: stage.key,
      order: stage.order,
      isTerminal: stage.isTerminal,
      isOffPath: stage.isOffPath,
      color: stage.color,
      labels: Object.fromEntries(
        TEMPLATE_LOCALES.map((locale) => [locale, (perLocale.get(locale) as ResolvedStage[])[i].label])
      ) as LocalizedLabel,
    })),
    slas: [],
    reminderDays: 14,
  };
}

/**
 * A graduating student, from application to a job offer. The shape a university
 * partnership produces: a screening call, a match with a host team, the
 * internship itself with a checkpoint in the middle, and a hiring decision at
 * the end.
 */
const GRADUATE_INTERNSHIP: ProgramTemplate = {
  key: 'graduate_internship',
  reminderDays: 14,
  stages: [
    {
      key: 'GRAD_APPLIED',
      order: 0,
      isTerminal: false,
      isOffPath: false,
      color: '#2563eb',
      labels: { en: 'Applied', tr: 'Başvurdu', de: 'Beworben' },
    },
    {
      key: 'GRAD_SCREENING',
      order: 1,
      isTerminal: false,
      isOffPath: false,
      color: '#0ea5e9',
      labels: { en: 'Screening call', tr: 'Ön görüşme', de: 'Erstgespräch' },
    },
    {
      key: 'GRAD_MATCHING',
      order: 2,
      isTerminal: false,
      isOffPath: false,
      color: '#8b5cf6',
      labels: { en: 'Matching with a team', tr: 'Ekiple eşleştirme', de: 'Team-Zuordnung' },
    },
    {
      key: 'GRAD_INTERNSHIP',
      order: 3,
      isTerminal: false,
      isOffPath: false,
      color: '#f59e0b',
      labels: { en: 'Internship running', tr: 'Staj sürüyor', de: 'Praktikum läuft' },
    },
    {
      key: 'GRAD_MIDPOINT_REVIEW',
      order: 4,
      isTerminal: false,
      isOffPath: false,
      color: '#f97316',
      labels: { en: 'Midpoint review', tr: 'Ara değerlendirme', de: 'Zwischenbewertung' },
    },
    {
      key: 'GRAD_FINAL_REVIEW',
      order: 5,
      isTerminal: false,
      isOffPath: false,
      color: '#14b8a6',
      labels: { en: 'Final review', tr: 'Bitirme değerlendirmesi', de: 'Abschlussbewertung' },
    },
    {
      key: 'GRAD_HIRED',
      order: 6,
      isTerminal: true,
      isOffPath: false,
      color: '#16a34a',
      labels: { en: 'Hired', tr: 'İşe alındı', de: 'Eingestellt' },
    },
    {
      key: 'GRAD_WITHDREW',
      order: 7,
      isTerminal: true,
      isOffPath: true,
      color: '#9ca3af',
      labels: { en: 'Withdrew', tr: 'Süreçten ayrıldı', de: 'Abgesprungen' },
    },
  ],
  slas: [
    { stageKey: 'GRAD_APPLIED', days: 5 },
    { stageKey: 'GRAD_SCREENING', days: 7 },
    { stageKey: 'GRAD_MATCHING', days: 14 },
    { stageKey: 'GRAD_INTERNSHIP', days: 90 },
    { stageKey: 'GRAD_MIDPOINT_REVIEW', days: 7 },
    { stageKey: 'GRAD_FINAL_REVIEW', days: 14 },
  ],
  documentRequirements: [
    {
      key: 'GRAD_CV',
      appliesToStage: 'GRAD_APPLIED',
      mandatory: true,
      labels: { en: 'CV', tr: 'Özgeçmiş', de: 'Lebenslauf' },
    },
    {
      key: 'GRAD_INTERNSHIP_AGREEMENT',
      appliesToStage: 'GRAD_INTERNSHIP',
      mandatory: true,
      labels: { en: 'Internship agreement', tr: 'Staj sözleşmesi', de: 'Praktikumsvertrag' },
    },
  ],
};

/**
 * A new joiner and the colleague who shows them the ropes. Nothing is being
 * selected here — the person is already hired — so the shape is a calendar:
 * pairing, the first week, and the three check-ins that decide whether the
 * onboarding worked.
 */
const ONBOARDING_BUDDY: ProgramTemplate = {
  key: 'onboarding_buddy',
  reminderDays: 7,
  stages: [
    {
      key: 'BUDDY_PAIRED',
      order: 0,
      isTerminal: false,
      isOffPath: false,
      color: '#2563eb',
      labels: { en: 'Buddy assigned', tr: 'Rehber atandı', de: 'Buddy zugeteilt' },
    },
    {
      key: 'BUDDY_FIRST_WEEK',
      order: 1,
      isTerminal: false,
      isOffPath: false,
      color: '#0ea5e9',
      labels: { en: 'First week', tr: 'İlk hafta', de: 'Erste Woche' },
    },
    {
      key: 'BUDDY_DAY_30',
      order: 2,
      isTerminal: false,
      isOffPath: false,
      color: '#8b5cf6',
      labels: { en: '30-day check-in', tr: '30. gün görüşmesi', de: '30-Tage-Gespräch' },
    },
    {
      key: 'BUDDY_DAY_60',
      order: 3,
      isTerminal: false,
      isOffPath: false,
      color: '#f59e0b',
      labels: { en: '60-day check-in', tr: '60. gün görüşmesi', de: '60-Tage-Gespräch' },
    },
    {
      key: 'BUDDY_DAY_90',
      order: 4,
      isTerminal: false,
      isOffPath: false,
      color: '#14b8a6',
      labels: { en: '90-day review', tr: '90. gün değerlendirmesi', de: '90-Tage-Bilanz' },
    },
    {
      key: 'BUDDY_COMPLETED',
      order: 5,
      isTerminal: true,
      isOffPath: false,
      color: '#16a34a',
      labels: { en: 'Onboarding complete', tr: 'Uyum süreci tamamlandı', de: 'Onboarding abgeschlossen' },
    },
    {
      key: 'BUDDY_ENDED_EARLY',
      order: 6,
      isTerminal: true,
      isOffPath: true,
      color: '#9ca3af',
      labels: { en: 'Ended early', tr: 'Erken sonlandı', de: 'Vorzeitig beendet' },
    },
  ],
  slas: [
    { stageKey: 'BUDDY_PAIRED', days: 3 },
    { stageKey: 'BUDDY_FIRST_WEEK', days: 7 },
    { stageKey: 'BUDDY_DAY_30', days: 30 },
    { stageKey: 'BUDDY_DAY_60', days: 30 },
    { stageKey: 'BUDDY_DAY_90', days: 30 },
  ],
};

/**
 * A development cohort that runs to a fixed calendar: people are nominated,
 * accept, agree what they want to get out of it, and finish by showing the
 * work. The stages are commitments, not selection steps — everyone who enrolls
 * is expected to graduate.
 */
const LEADERSHIP_COHORT: ProgramTemplate = {
  key: 'leadership_cohort',
  reminderDays: 21,
  stages: [
    {
      key: 'COHORT_NOMINATED',
      order: 0,
      isTerminal: false,
      isOffPath: false,
      color: '#2563eb',
      labels: { en: 'Nominated', tr: 'Aday gösterildi', de: 'Nominiert' },
    },
    {
      key: 'COHORT_ENROLLED',
      order: 1,
      isTerminal: false,
      isOffPath: false,
      color: '#0ea5e9',
      labels: { en: 'Enrolled in the cohort', tr: 'Kohorta katıldı', de: 'In die Kohorte aufgenommen' },
    },
    {
      key: 'COHORT_GOALS_AGREED',
      order: 2,
      isTerminal: false,
      isOffPath: false,
      color: '#8b5cf6',
      labels: {
        en: 'Development goals agreed',
        tr: 'Gelişim hedefleri belirlendi',
        de: 'Entwicklungsziele vereinbart',
      },
    },
    {
      key: 'COHORT_MIDPOINT',
      order: 3,
      isTerminal: false,
      isOffPath: false,
      color: '#f59e0b',
      labels: { en: 'Midpoint review', tr: 'Dönem ortası değerlendirme', de: 'Halbzeitgespräch' },
    },
    {
      key: 'COHORT_SHOWCASE',
      order: 4,
      isTerminal: false,
      isOffPath: false,
      color: '#14b8a6',
      labels: { en: 'Final showcase', tr: 'Bitirme sunumu', de: 'Abschlusspräsentation' },
    },
    {
      key: 'COHORT_GRADUATED',
      order: 5,
      isTerminal: true,
      isOffPath: false,
      color: '#16a34a',
      labels: { en: 'Graduated', tr: 'Programı tamamladı', de: 'Programm abgeschlossen' },
    },
    {
      key: 'COHORT_LEFT',
      order: 6,
      isTerminal: true,
      isOffPath: true,
      color: '#9ca3af',
      labels: { en: 'Left the cohort', tr: 'Kohorttan ayrıldı', de: 'Kohorte verlassen' },
    },
  ],
  slas: [
    { stageKey: 'COHORT_NOMINATED', days: 10 },
    { stageKey: 'COHORT_ENROLLED', days: 14 },
    { stageKey: 'COHORT_GOALS_AGREED', days: 21 },
    { stageKey: 'COHORT_MIDPOINT', days: 45 },
    { stageKey: 'COHORT_SHOWCASE', days: 30 },
  ],
};

/**
 * Someone changing career, supported until they land. The long middle stage is
 * the point: reskilling takes months, and a shape that has no room for it
 * reports every participant as overdue by week three. "On hold" is off-path but
 * NOT terminal — people pause a transition and come back.
 */
const CAREER_TRANSITION: ProgramTemplate = {
  key: 'career_transition',
  reminderDays: 14,
  stages: [
    {
      key: 'SWITCH_INTAKE',
      order: 0,
      isTerminal: false,
      isOffPath: false,
      color: '#2563eb',
      labels: { en: 'Intake conversation', tr: 'Tanışma görüşmesi', de: 'Aufnahmegespräch' },
    },
    {
      key: 'SWITCH_SKILL_GAP',
      order: 1,
      isTerminal: false,
      isOffPath: false,
      color: '#0ea5e9',
      labels: { en: 'Skills gap mapped', tr: 'Beceri açığı çıkarıldı', de: 'Kompetenzlücke erfasst' },
    },
    {
      key: 'SWITCH_RESKILLING',
      order: 2,
      isTerminal: false,
      isOffPath: false,
      color: '#8b5cf6',
      labels: { en: 'Reskilling in progress', tr: 'Yeniden beceri kazanıyor', de: 'Umschulung läuft' },
    },
    {
      key: 'SWITCH_APPLYING',
      order: 3,
      isTerminal: false,
      isOffPath: false,
      color: '#f59e0b',
      labels: { en: 'Applying for roles', tr: 'İşlere başvuruyor', de: 'Bewirbt sich' },
    },
    {
      key: 'SWITCH_INTERVIEWING',
      order: 4,
      isTerminal: false,
      isOffPath: false,
      color: '#14b8a6',
      labels: { en: 'Interviewing', tr: 'Görüşmelerde', de: 'In Vorstellungsgesprächen' },
    },
    {
      key: 'SWITCH_PLACED',
      order: 5,
      isTerminal: true,
      isOffPath: false,
      color: '#16a34a',
      labels: { en: 'Placed in a new role', tr: 'Yeni işine başladı', de: 'Neue Stelle angetreten' },
    },
    {
      key: 'SWITCH_ON_HOLD',
      order: 6,
      isTerminal: false,
      isOffPath: true,
      color: '#9ca3af',
      labels: { en: 'On hold', tr: 'Beklemede', de: 'Pausiert' },
    },
  ],
  slas: [
    { stageKey: 'SWITCH_INTAKE', days: 7 },
    { stageKey: 'SWITCH_SKILL_GAP', days: 14 },
    { stageKey: 'SWITCH_RESKILLING', days: 90 },
    { stageKey: 'SWITCH_APPLYING', days: 30 },
    { stageKey: 'SWITCH_INTERVIEWING', days: 21 },
  ],
  documentRequirements: [
    {
      key: 'SWITCH_CV',
      appliesToStage: 'SWITCH_APPLYING',
      mandatory: true,
      labels: { en: 'Updated CV', tr: 'Güncel özgeçmiş', de: 'Aktueller Lebenslauf' },
    },
    {
      key: 'SWITCH_LEARNING_PLAN',
      appliesToStage: 'SWITCH_RESKILLING',
      mandatory: false,
      labels: { en: 'Learning plan', tr: 'Öğrenme planı', de: 'Lernplan' },
    },
  ],
};

/**
 * The catalogue. Order is the order the picker shows: the canonical set first
 * because it is what the product does today, then the four shapes an
 * organization is most likely to recognise as its own.
 */
export const PROGRAM_TEMPLATES: ProgramTemplate[] = [
  canonicalTemplate(),
  GRADUATE_INTERNSHIP,
  ONBOARDING_BUDDY,
  LEADERSHIP_COHORT,
  CAREER_TRANSITION,
];

/** One template by key, or null when the key is unknown (never throws). */
export function programTemplate(key: string | null | undefined): ProgramTemplate | null {
  if (!key) return null;
  return PROGRAM_TEMPLATES.find((t) => t.key === key) ?? null;
}

// ── Reading a template ───────────────────────────────────────────────────────

/**
 * A template's stages in one language, in the shape the rest of the app already
 * speaks (`ResolvedStage`) — so a preview renders through the same components
 * as a live pipeline.
 */
export function templateStages(template: ProgramTemplate, locale: Locale = 'en'): ResolvedStage[] {
  return [...template.stages]
    .sort((a, b) => a.order - b.order)
    .map((s) => ({
      key: s.key,
      label: s.labels[locale] ?? s.labels.en,
      order: s.order,
      isTerminal: s.isTerminal,
      isOffPath: s.isOffPath,
      color: s.color,
    }));
}

/**
 * The exact request body `PUT /api/admin/organizations/[id]/pipeline-stages`
 * accepts. There is deliberately no second writer: the editor endpoint stays
 * the only thing that touches `PipelineStage`, so its authz, its premium gate
 * and its validation apply to a template exactly as they apply to a hand-built
 * set.
 */
export function templateStagePayload(template: ProgramTemplate, locale: Locale = 'en') {
  return {
    stages: templateStages(template, locale).map((s) => ({
      key: s.key,
      label: s.label,
      order: s.order,
      isTerminal: s.isTerminal,
      isOffPath: s.isOffPath,
      color: s.color,
    })),
  };
}

// ── Applying a template safely ───────────────────────────────────────────────

/**
 * Why a template may not be applied to an organization as it stands.
 *
 *   · `stranded_relations` — someone is currently sitting on a stage key the
 *     template does not contain. The editor endpoint replaces the stage set
 *     with deleteMany + createMany and remaps nothing (#1634), so their
 *     `pipelineStatus` would point at a stage that no longer exists: no board
 *     column, no funnel row, no way out. This is a REFUSAL, not a warning —
 *     move or finish those people first.
 *   · `unconfirmed_replace` — the organization already customised its stages
 *     and the admin has not confirmed that applying replaces them. Overridable
 *     by an explicit confirmation that says what will happen, never by a
 *     default-on checkbox.
 */
export type ProgramApplyBlocker = 'stranded_relations' | 'unconfirmed_replace';

export interface ProgramApplyTarget {
  /** Custom `PipelineStage` rows the org has today (0 = still on the built-ins). */
  existingStageCount: number;
  /** Distinct stage keys relations currently sit on. Empty for a fresh programme. */
  occupiedStageKeys: string[];
  /** The admin confirmed, in words, that applying replaces the current stages. */
  confirmed?: boolean;
}

/**
 * Every reason this template cannot be applied to this organization right now.
 * Empty means it is safe. Pure — the caller supplies the two counts, so the
 * rule is testable without a database and identical on the client and the
 * server.
 */
export function templateApplyBlockers(
  template: ProgramTemplate,
  target: ProgramApplyTarget
): ProgramApplyBlocker[] {
  const blockers: ProgramApplyBlocker[] = [];
  const keys = new Set(template.stages.map((s) => s.key));
  if (target.occupiedStageKeys.some((k) => !keys.has(k))) blockers.push('stranded_relations');
  if (target.existingStageCount > 0 && !target.confirmed) blockers.push('unconfirmed_replace');
  return blockers;
}

/** Convenience for a caller that only needs the yes/no. */
export function canApplyTemplate(template: ProgramTemplate, target: ProgramApplyTarget): boolean {
  return templateApplyBlockers(template, target).length === 0;
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Everything wrong with a template, as human-readable problems (empty = valid).
 *
 * A malformed template is invisible until someone applies it and the endpoint
 * answers 400, by which point the wizard has already promised it would work.
 * The catalogue test calls this on every entry, so a bad template is a red
 * build instead.
 */
export function validateProgramTemplate(template: ProgramTemplate): string[] {
  const problems: string[] = [];
  const at = (msg: string) => `${template.key}: ${msg}`;

  if (!STAGE_KEY_RE.test(template.key)) problems.push(at('template key must be [A-Za-z0-9_]'));
  if (template.key.length > MAX_KEY_LENGTH) problems.push(at(`template key exceeds ${MAX_KEY_LENGTH} chars`));
  if (!Number.isInteger(template.reminderDays) || template.reminderDays < 1) {
    problems.push(at('reminderDays must be a positive whole number of days'));
  }

  if (template.stages.length === 0) problems.push(at('has no stages'));
  if (template.stages.length > MAX_STAGES) problems.push(at(`has more than ${MAX_STAGES} stages`));

  const seen = new Set<string>();
  for (const stage of template.stages) {
    if (seen.has(stage.key)) problems.push(at(`duplicate stage key "${stage.key}"`));
    seen.add(stage.key);
    if (!STAGE_KEY_RE.test(stage.key)) problems.push(at(`stage key "${stage.key}" must be [A-Za-z0-9_]`));
    if (stage.key.length > MAX_KEY_LENGTH) {
      problems.push(at(`stage key "${stage.key}" exceeds ${MAX_KEY_LENGTH} chars`));
    }
    if (!Number.isInteger(stage.order) || stage.order < 0) {
      problems.push(at(`stage "${stage.key}" has a non-ordinal order`));
    }
    if (stage.color !== null && !HEX_COLOR_RE.test(stage.color)) {
      problems.push(at(`stage "${stage.key}" has a non-hex color`));
    }
    for (const locale of TEMPLATE_LOCALES) {
      if (!stage.labels[locale]?.trim()) {
        problems.push(at(`stage "${stage.key}" has no ${locale} label`));
      }
    }
  }

  const orders = template.stages.map((s) => s.order);
  if (new Set(orders).size !== orders.length) problems.push(at('two stages share an order'));

  // Exactly one first on-path stage: the set has to have a start, and it has to
  // be unambiguous — `startStageKey()` takes the lowest-ordered on-path stage,
  // and a tie there means a new relation's starting stage depends on array
  // order rather than on the template.
  const onPath = template.stages.filter((s) => !s.isOffPath);
  if (onPath.length === 0) {
    problems.push(at('has no on-path stage, so a new relation would have nowhere to start'));
  } else {
    const first = Math.min(...onPath.map((s) => s.order));
    if (onPath.filter((s) => s.order === first).length !== 1) {
      problems.push(at('has more than one first on-path stage'));
    }
    if (!onPath.some((s) => s.isTerminal)) {
      problems.push(at('has no terminal on-path stage, so nobody can ever finish'));
    }
  }

  const slaKeys = new Set<string>();
  for (const sla of template.slas) {
    if (!seen.has(sla.stageKey)) problems.push(at(`SLA names unknown stage "${sla.stageKey}"`));
    if (slaKeys.has(sla.stageKey)) problems.push(at(`duplicate SLA for stage "${sla.stageKey}"`));
    slaKeys.add(sla.stageKey);
    if (!Number.isInteger(sla.days) || sla.days < 1) {
      problems.push(at(`SLA for "${sla.stageKey}" must be a positive whole number of days`));
    }
  }

  const docKeys = new Set<string>();
  for (const doc of template.documentRequirements ?? []) {
    if (docKeys.has(doc.key)) problems.push(at(`duplicate document requirement "${doc.key}"`));
    docKeys.add(doc.key);
    if (doc.appliesToStage && !seen.has(doc.appliesToStage)) {
      problems.push(at(`document "${doc.key}" names unknown stage "${doc.appliesToStage}"`));
    }
    for (const locale of TEMPLATE_LOCALES) {
      if (!doc.labels[locale]?.trim()) problems.push(at(`document "${doc.key}" has no ${locale} label`));
    }
  }

  return problems;
}

/**
 * Every problem across the whole catalogue, including the one thing a single
 * template cannot see: two templates claiming the same key.
 */
export function validateProgramTemplates(templates: ProgramTemplate[] = PROGRAM_TEMPLATES): string[] {
  const problems = templates.flatMap(validateProgramTemplate);
  const keys = templates.map((t) => t.key);
  const duplicates = keys.filter((k, i) => keys.indexOf(k) !== i);
  for (const key of new Set(duplicates)) problems.push(`duplicate template key "${key}"`);
  return problems;
}

// ── Names and descriptions ───────────────────────────────────────────────────

/** The localized name/description pair a picker shows for one template. */
export interface ProgramTemplateCopy {
  name: string;
  desc: string;
}

/**
 * A template's name and description in the reader's language. Kept out of this
 * module on purpose: names and descriptions are UI copy and live in the
 * dictionary (`programTemplates.items`, EN/TR/DE, parity enforced by
 * `npm run check:i18n`), exactly like `featureCatalog`. Structurally typed so
 * both the server `Dictionary` and the client one satisfy it.
 */
export function programTemplateCopy(
  dict: { programTemplates: { items: Record<string, ProgramTemplateCopy> } },
  key: string
): ProgramTemplateCopy | null {
  return dict.programTemplates.items[key] ?? null;
}
