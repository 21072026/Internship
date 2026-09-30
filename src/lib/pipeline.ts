// Single source of truth for the mentee pipeline stages (mirrors the Prisma
// PipelineStatus enum). Enum identifiers are English; display labels are
// localized (EN/TR).
import { locales, type Locale } from '@/i18n/config';

export const PIPELINE_STATUSES = [
  'APPLICATION_100',
  'APPROVAL_PENDING_220',
  'INTERVIEW_PENDING_250',
  'INTRODUCTION_PENDING_270',
  'INTERNSHIP_STARTING_300',
  'INTERNSHIP_IN_PROGRESS_450',
  'INTERNSHIP_DROPPED_460',
  'INTERNSHIP_COMPLETED_490',
  'JOB_SEEKING_500',
  'HIREABLE_600',
  'HIRED_660',
  'EMPLOYED_700',
  'INTERNSHIP_FOUND_ELSEWHERE_800',
] as const;

export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

// The linear "happy path" a mentee progresses along, excluding the two off-path
// terminal states (dropped / found-internship-elsewhere). This is the order the
// journey tracker and any "advance one stage" action must follow — the raw
// PIPELINE_STATUSES array interleaves the off-path stages, so stepping through it
// by index would wrongly send an in-progress internship to "dropped" and an
// employed mentee to "found elsewhere".
export const ON_PATH_STATUSES = [
  'APPLICATION_100',
  'APPROVAL_PENDING_220',
  'INTERVIEW_PENDING_250',
  'INTRODUCTION_PENDING_270',
  'INTERNSHIP_STARTING_300',
  'INTERNSHIP_IN_PROGRESS_450',
  'INTERNSHIP_COMPLETED_490',
  'JOB_SEEKING_500',
  'HIREABLE_600',
  'HIRED_660',
  'EMPLOYED_700',
] as const satisfies readonly PipelineStatus[];

// The stages of the canonical catalogue that mean "reached the outcome" — the
// tail of ON_PATH_STATUSES, and for years the literal
// `new Set(['HIRED_660','EMPLOYED_700'])` copied into five analytics routes
// (#1882). It lives here, with the catalogue it describes, so those routes can
// generalise over a TENANT'S stages without naming a key: it is only the ANCHOR
// that lets `outcomeStageKeys()` (src/lib/pipelineStages.ts) reproduce this exact
// set for an org on the built-in stages while resolving a renamed pipeline's own
// final stage. `DEFAULT_HIRED_STAGE_KEY` in src/lib/offers.ts is the first of
// these and answers a different question (may we offer the "move to hired"
// suggestion?); #1504 is the issue that unifies the two.
export const CANONICAL_OUTCOME_KEYS = ['HIRED_660', 'EMPLOYED_700'] as const satisfies readonly PipelineStatus[];

// The next stage along the happy path, or null when the current stage is the
// terminal state (EMPLOYED_700) or an off-path status not on the sequence.
export function nextOnPathStatus(current: string): PipelineStatus | null {
  const idx = (ON_PATH_STATUSES as readonly string[]).indexOf(current);
  if (idx < 0 || idx >= ON_PATH_STATUSES.length - 1) return null;
  return ON_PATH_STATUSES[idx + 1];
}

const LABELS: Record<Locale, Record<PipelineStatus, string>> = {
  tr: {
    APPLICATION_100: '100 · İlk temas',
    APPROVAL_PENDING_220: '220 · Onay bekliyor',
    INTERVIEW_PENDING_250: '250 · Görüşülecek',
    INTRODUCTION_PENDING_270: '270 · Tanıştırılacak',
    INTERNSHIP_STARTING_300: '300 · Staj başlayacak',
    INTERNSHIP_IN_PROGRESS_450: '450 · Staj devam ediyor',
    INTERNSHIP_DROPPED_460: '460 · Staj yarım bıraktı',
    INTERNSHIP_COMPLETED_490: '490 · Staj bitti',
    JOB_SEEKING_500: '500 · İş arıyor',
    HIREABLE_600: '600 · İşe alınabilir',
    HIRED_660: '660 · İşe alındı',
    EMPLOYED_700: '700 · İş buldu',
    INTERNSHIP_FOUND_ELSEWHERE_800: '800 · Başka yerde staj buldu',
  },
  en: {
    APPLICATION_100: '100 · First contact',
    APPROVAL_PENDING_220: '220 · Awaiting approval',
    INTERVIEW_PENDING_250: '250 · To interview',
    INTRODUCTION_PENDING_270: '270 · To introduce',
    INTERNSHIP_STARTING_300: '300 · Internship starting',
    INTERNSHIP_IN_PROGRESS_450: '450 · Internship in progress',
    INTERNSHIP_DROPPED_460: '460 · Internship dropped',
    INTERNSHIP_COMPLETED_490: '490 · Internship completed',
    JOB_SEEKING_500: '500 · Job seeking',
    HIREABLE_600: '600 · Hireable',
    HIRED_660: '660 · Hired',
    EMPLOYED_700: '700 · Employed',
    INTERNSHIP_FOUND_ELSEWHERE_800: '800 · Internship elsewhere',
  },
  de: {
    APPLICATION_100: '100 · Erstkontakt',
    APPROVAL_PENDING_220: '220 · Warte auf Freigabe',
    INTERVIEW_PENDING_250: '250 · Zu interviewen',
    INTRODUCTION_PENDING_270: '270 · Vorzustellen',
    INTERNSHIP_STARTING_300: '300 · Praktikum beginnt',
    INTERNSHIP_IN_PROGRESS_450: '450 · Praktikum läuft',
    INTERNSHIP_DROPPED_460: '460 · Praktikum abgebrochen',
    INTERNSHIP_COMPLETED_490: '490 · Praktikum abgeschlossen',
    JOB_SEEKING_500: '500 · Jobsuche',
    HIREABLE_600: '600 · Einstellbar',
    HIRED_660: '660 · Eingestellt',
    EMPLOYED_700: '700 · Beschäftigt',
    INTERNSHIP_FOUND_ELSEWHERE_800: '800 · Praktikum anderswo',
  },
};

export function pipelineLabel(status: string, locale: Locale = 'en'): string {
  return LABELS[locale]?.[status as PipelineStatus] ?? LABELS.en[status as PipelineStatus] ?? status;
}

export function pipelineOptions(locale: Locale = 'en') {
  return PIPELINE_STATUSES.map((value) => ({ value, label: pipelineLabel(value, locale) }));
}

// Logical groupings of the 13 stages, so the kanban board can collapse the
// horizontal sprawl into three phases: before the internship, during it, and
// the outcome. Every PipelineStatus belongs to exactly one group.
export type PipelineGroupKey = 'pre' | 'internship' | 'result' | 'custom';

export const PIPELINE_GROUPS: { key: PipelineGroupKey; statuses: PipelineStatus[] }[] = [
  {
    key: 'pre',
    statuses: ['APPLICATION_100', 'APPROVAL_PENDING_220', 'INTERVIEW_PENDING_250', 'INTRODUCTION_PENDING_270'],
  },
  {
    key: 'internship',
    statuses: ['INTERNSHIP_STARTING_300', 'INTERNSHIP_IN_PROGRESS_450', 'INTERNSHIP_DROPPED_460', 'INTERNSHIP_COMPLETED_490'],
  },
  {
    key: 'result',
    statuses: ['JOB_SEEKING_500', 'HIREABLE_600', 'HIRED_660', 'EMPLOYED_700', 'INTERNSHIP_FOUND_ELSEWHERE_800'],
  },
];

// Group the VIEWER'S resolved stages rather than the enum constant above.
// A tenant with a customized pipeline (#747) has stage keys that appear in no
// PIPELINE_GROUPS entry, so iterating the constant made those stages invisible
// on the desktop admin board — while the phone list, which reads the resolved
// stages, showed them (#828). Unknown keys land in a trailing "custom" group in
// the tenant's own stage order; empty groups drop out, so a tenant that only
// renamed the defaults still sees the familiar three phases.
export function groupResolvedStages(
  stages: ResolvedStage[],
): { key: PipelineGroupKey; statuses: string[] }[] {
  const grouped = new Set<string>(PIPELINE_GROUPS.flatMap((g) => g.statuses as string[]));
  const byOrder = [...stages].sort((a, b) => a.order - b.order);
  const out = PIPELINE_GROUPS.map((g) => ({
    key: g.key,
    statuses: byOrder.filter((s) => (g.statuses as string[]).includes(s.key)).map((s) => s.key),
  })).filter((g) => g.statuses.length > 0);
  const custom = byOrder.filter((s) => !grouped.has(s.key)).map((s) => s.key);
  if (custom.length > 0) out.push({ key: 'custom' as PipelineGroupKey, statuses: custom });
  return out;
}

// Mentee-facing "what to do now" guidance per stage — turns the journey from a
// passive status display into actionable direction. Off-path statuses
// (dropped / found elsewhere) aren't included; the tracker shows a note instead.
const GUIDANCE: Record<Locale, Partial<Record<PipelineStatus, string>>> = {
  en: {
    APPLICATION_100: 'Your application is being reviewed. Make sure your profile, CV and skills are complete — a strong profile speeds this up.',
    APPROVAL_PENDING_220: 'Awaiting approval to move forward. No action needed yet — just keep your profile up to date and stay reachable.',
    INTERVIEW_PENDING_250: 'An interview is coming up. Confirm your availability with your mentor, and prepare using the Interview prep checklist template.',
    INTRODUCTION_PENDING_270: "You're about to be introduced to your mentor/company. Reply promptly to messages and meeting requests.",
    INTERNSHIP_STARTING_300: 'Your internship is about to start. Confirm the start date and logistics with your mentor.',
    INTERNSHIP_IN_PROGRESS_450: 'Log your progress regularly, ask questions through Q&A, and keep your skills list current.',
    INTERNSHIP_COMPLETED_490: 'Internship complete — update your CV and skills, and talk to your mentor about next steps.',
    JOB_SEEKING_500: "You're job-seeking. Keep your target position and skills current, and use the Cover letter / CV templates.",
    HIREABLE_600: "You're marked as hireable — stay in touch with your mentor and be ready for an offer conversation.",
    HIRED_660: 'Congratulations! Coordinate onboarding details (start date, paperwork) with the company.',
    EMPLOYED_700: "You've completed the journey — congratulations on finding a role!",
  },
  tr: {
    APPLICATION_100: 'Başvurun değerlendiriliyor. Profilinin, CV\'nin ve becerilerinin eksiksiz olduğundan emin ol — güçlü bir profil süreci hızlandırır.',
    APPROVAL_PENDING_220: 'İlerlemek için onay bekleniyor. Şimdilik yapman gereken bir şey yok — profilini güncel tut ve ulaşılabilir ol.',
    INTERVIEW_PENDING_250: 'Bir görüşme yaklaşıyor. Uygunluğunu mentörünle teyit et ve Mülakat hazırlık listesi şablonuyla hazırlan.',
    INTRODUCTION_PENDING_270: 'Mentörün/şirketinle tanıştırılmak üzeresin. Mesajlara ve toplantı taleplerine hızlı yanıt ver.',
    INTERNSHIP_STARTING_300: 'Stajın başlamak üzere. Başlangıç tarihini ve lojistiği mentörünle teyit et.',
    INTERNSHIP_IN_PROGRESS_450: 'İlerlemeni düzenli olarak kaydet, Soru-Cevap üzerinden sorular sor ve yetenek listeni güncel tut.',
    INTERNSHIP_COMPLETED_490: 'Staj tamamlandı — CV\'ni ve becerilerini güncelle, sonraki adımları mentörünle konuş.',
    JOB_SEEKING_500: 'İş arıyorsun. Hedef pozisyonunu ve becerilerini güncel tut, Ön yazı / CV şablonlarını kullan.',
    HIREABLE_600: 'İşe alınabilir olarak işaretlendin — mentörünle iletişimde kal ve bir teklif görüşmesine hazır ol.',
    HIRED_660: 'Tebrikler! İşe başlama detaylarını (tarih, evraklar) şirketle koordine et.',
    EMPLOYED_700: 'Yolculuğunu tamamladın — bir iş bulduğun için tebrikler!',
  },
  de: {
    APPLICATION_100: 'Deine Bewerbung wird geprüft. Stelle sicher, dass dein Profil, Lebenslauf und deine Fähigkeiten vollständig sind — ein starkes Profil beschleunigt das.',
    APPROVAL_PENDING_220: 'Warten auf Freigabe. Momentan ist nichts zu tun — halte dein Profil aktuell und bleib erreichbar.',
    INTERVIEW_PENDING_250: 'Ein Interview steht bevor. Bestätige deine Verfügbarkeit bei deinem Mentor und bereite dich mit der Interview-Vorbereitungs-Checkliste vor.',
    INTRODUCTION_PENDING_270: 'Du wirst deinem Mentor/Unternehmen bald vorgestellt. Antworte zügig auf Nachrichten und Terminanfragen.',
    INTERNSHIP_STARTING_300: 'Dein Praktikum beginnt bald. Bestätige Starttermin und Logistik mit deinem Mentor.',
    INTERNSHIP_IN_PROGRESS_450: 'Halte deinen Fortschritt regelmäßig fest, stelle Fragen über Q&A und halte deine Fähigkeitenliste aktuell.',
    INTERNSHIP_COMPLETED_490: 'Praktikum abgeschlossen — aktualisiere Lebenslauf und Fähigkeiten und besprich die nächsten Schritte mit deinem Mentor.',
    JOB_SEEKING_500: 'Du suchst einen Job. Halte Zielposition und Fähigkeiten aktuell und nutze die Anschreiben-/Lebenslauf-Vorlagen.',
    HIREABLE_600: 'Du bist als einstellbar markiert — bleib mit deinem Mentor in Kontakt und sei bereit für ein Angebotsgespräch.',
    HIRED_660: 'Herzlichen Glückwunsch! Kläre die Einstiegsdetails (Starttermin, Unterlagen) mit dem Unternehmen.',
    EMPLOYED_700: 'Du hast die Reise abgeschlossen — herzlichen Glückwunsch zu deiner neuen Stelle!',
  },
};

export function pipelineGuidance(status: string, locale: Locale = 'en'): string | null {
  return GUIDANCE[locale]?.[status as PipelineStatus] ?? GUIDANCE.en[status as PipelineStatus] ?? null;
}

// ── Resolved (possibly per-tenant) stages (#747) ─────────────────────────────
// Client-safe shape + canonical defaults. The DB-backed resolver
// (resolvePipelineStages) lives in src/lib/pipelineStages.ts (server-only); these
// pure helpers are here so client components can share the type + default set
// without pulling in Prisma.
export interface ResolvedStage {
  key: string;
  label: string;
  order: number;
  isTerminal: boolean;
  isOffPath: boolean;
  color: string | null;
}

const DEFAULT_OFF_PATH = new Set<string>(['INTERNSHIP_DROPPED_460', 'INTERNSHIP_FOUND_ELSEWHERE_800']);
const DEFAULT_TERMINAL = new Set<string>([
  'EMPLOYED_700',
  'INTERNSHIP_DROPPED_460',
  'INTERNSHIP_FOUND_ELSEWHERE_800',
]);

// What each OFF-PATH stage of the canonical catalogue means for the person on
// it (#830): leaving the path is not always bad news. FOUND_ELSEWHERE is a
// success — the student found an internship — and communicated like the
// rejection DROPPED is, the message lands badly. `isOffPath` alone cannot tell
// the two apart, so the catalogue states it here, next to the stages it
// describes, and `outcomeForStage()` (src/lib/outcomeComms.ts) asks instead of
// naming the keys (#1880). A tenant's own off-path stage has no entry: nobody
// told us it is good news, so it takes the neutral 'ended' wording.
export type OffPathMeaning = 'success' | 'ended';

const CANONICAL_OFF_PATH_MEANING: Record<string, OffPathMeaning> = {
  INTERNSHIP_FOUND_ELSEWHERE_800: 'success',
  INTERNSHIP_DROPPED_460: 'ended',
};

export function canonicalOffPathMeaning(key: string): OffPathMeaning | null {
  return CANONICAL_OFF_PATH_MEANING[key] ?? null;
}

// The product's canonical stage set, derived from the enum (single source of
// truth). Used whenever a tenant hasn't customized its pipeline.
export function defaultPipelineStages(locale: Locale = 'en'): ResolvedStage[] {
  return PIPELINE_STATUSES.map((key, i) => ({
    key,
    label: pipelineLabel(key, locale),
    order: i,
    isTerminal: DEFAULT_TERMINAL.has(key),
    isOffPath: DEFAULT_OFF_PATH.has(key),
    color: null,
  }));
}

// The happy-path key sequence (excludes off-path), sorted by order.
export function onPathKeys(stages: ResolvedStage[]): string[] {
  return stages.filter((s) => !s.isOffPath).sort((a, b) => a.order - b.order).map((s) => s.key);
}

// The stage a brand-new relation must start on (#1634).
//
// `MentorshipRelation.pipelineStatus` defaults to the canonical first key in the
// schema, which is right for a tenant on the built-in catalogue and wrong for
// every tenant that customised its pipeline: a relation parked on a key that is
// absent from the tenant's own set has no board column, no funnel row and no way
// out — the mentee is simply invisible. So a create resolves the tenant's stages
// and writes the first ON-PATH one explicitly.
//
// Off-path stages (the dropped / found-elsewhere kind, `isOffPath`) can never be
// a start: `onPathKeys` already drops them, so a tenant that ordered its
// "Withdrew" stage first still starts on its first real stage. Pure and
// Prisma-free — the DB-backed wrapper is `resolveStartStage()` in
// src/lib/pipelineStages.ts.
//
// The canonical key is the fallback for an EMPTY set only, which is exactly the
// org that resolves to the built-in catalogue — so single-tenant behaviour is
// byte-identical. A tenant whose set is non-empty but has no on-path stage at
// all (the editor accepts `isOffPath` on every row) must NOT get the canonical
// key: it is in none of its `PipelineStage` rows, which is precisely the
// invisible-relation bug this exists to prevent. Its own first stage by order
// is a stage it can at least see and move out of.
export const DEFAULT_START_STAGE = 'APPLICATION_100';

export function startStageKey(stages: ResolvedStage[]): string {
  const onPath = onPathKeys(stages);
  if (onPath.length > 0) return onPath[0];
  const firstByOrder = [...stages].sort((a, b) => a.order - b.order)[0];
  return firstByOrder?.key ?? DEFAULT_START_STAGE;
}

// Label lookup over a resolved set, falling back to the canonical label and then
// the raw key — so a custom key always renders something sensible. A blank
// stored label falls through too; see `isDefaultLabel`.
export function stageLabel(stages: ResolvedStage[], key: string, locale: Locale = 'en'): string {
  return stages.find((s) => s.key === key)?.label || pipelineLabel(key, locale);
}

// Is this stored label one the tenant never actually chose? Two shapes count:
// blank (what a save now writes for an untouched built-in stage), and a
// byte-for-byte copy of one of OUR OWN built-in labels — which is what the stage
// editor used to persist. Its GET prefilled the 13 built-in labels resolved in
// the wrong language and Save posted them straight back, so one click on an
// untouched editor froze English into the DB for every reader in every language
// (#2268).
//
// Matching ANY locale, not just the viewer's, is deliberate: it means an admin
// who only recoloured or reordered the built-in stages keeps translated labels.
// The cost is that a tenant cannot pin our German string as a fixed label for
// Turkish readers — the right trade for a stage nobody renamed. Typing anything
// that differs by a character is still honoured verbatim.
export function isDefaultLabel(key: string, label: string): boolean {
  const trimmed = label.trim();
  if (!trimmed) return true;
  if (!(PIPELINE_STATUSES as readonly string[]).includes(key)) return false;
  return locales.some((l) => pipelineLabel(key, l) === trimmed);
}

// Fill in the built-in localized label for every stage the tenant did not
// rename, leaving genuinely custom labels exactly as they were set.
export function localizeStageLabels(stages: ResolvedStage[], locale: Locale): ResolvedStage[] {
  return stages.map((s) =>
    isDefaultLabel(s.key, s.label) ? { ...s, label: pipelineLabel(s.key, locale) } : s
  );
}

// ── "Did this person finish?" — one definition (#1882) ───────────────────────
//
// Five paid reports (cohort comparison, source conversion, the cross-program
// benchmark, the admin headline conversion and mentor analytics) each decided
// that question with their own copy of `new Set(['HIRED_660','EMPLOYED_700'])`.
// A tenant that renamed its stages (#747) holds neither key, so all five
// reported zero — not an error, not an empty state, just a confident nought.
//
// THE RULE, and why it is not simply "the last on-path stage".
//
// The obvious generalisation — finished = the last on-path key — is WRONG for
// the catalogue every live tenant is on today: the default set ends
// … HIREABLE_600 → HIRED_660 → EMPLOYED_700, and "the last key" is EMPLOYED_700
// alone. That would silently stop counting every relation parked on HIRED_660,
// which is most of them. So the rule has an ANCHOR:
//
//   anchor   = the first on-path stage (by order) whose key is one of the
//              canonical outcome keys, or — for a set that holds neither, i.e. a
//              genuinely custom pipeline — the last on-path stage.
//   finished = every on-path stage ordered at or beyond the anchor.
//
// Default catalogue → anchor HIRED_660 → { HIRED_660, EMPLOYED_700 }: byte-for-
// byte the set the five routes hardcoded. Renamed catalogue (STAGE_A…STAGE_F)
// → anchor STAGE_F → { STAGE_F }. A tenant that kept HIRED_660 and appended its
// own "Probation passed" after it counts both, which is the point of "at or
// beyond": reaching the outcome and then moving further along is still reaching
// the outcome.
//
// `offPath` is the other hardcoded set the same routes carried
// (`INTERNSHIP_DROPPED_460` / `INTERNSHIP_FOUND_ELSEWHERE_800`); for the default
// catalogue `isOffPath` marks exactly those two, so that is byte-identical too.
//
// NOT a fork of #1504's placement definition: that issue's `src/lib/placement.ts`
// does not exist on `main` (verified by `git grep`), and it is about WHICH
// RELATIONS count (coaching vs placement, employment attribution). This is about
// WHICH STAGES mean "finished" in a tenant's own vocabulary. When #1504 lands it
// should read `finished` from here rather than re-listing stage keys.

export interface OutcomeStageKeys {
  /** Stage keys that mean "reached the outcome", in the tenant's own order. */
  finished: string[];
  /**
   * What the tenant calls the anchor stage, in the caller's locale — so a
   * screen can NAME the thing it counted instead of asserting a universal
   * "Hired". Empty only for the degenerate set with no on-path stage at all.
   */
  finishedLabel: string;
  /**
   * False when `finishedLabel` is merely our own built-in label for a built-in
   * key — i.e. the tenant never named this stage. A screen that already has a
   * good word of its own ("Hired", "İşe alınan", "Eingestellt", translated in
   * all three dictionaries) should keep using it in that case, so a tenant on
   * the default catalogue sees exactly the text it saw before #1882. True means
   * the tenant typed a name, and that name must win.
   */
  finishedLabelIsCustom: boolean;
  /** Off-path stage keys ("dropped", "found elsewhere"), in tenant order. */
  offPath: string[];
  /** The stage a journey starts on — the single definition in `startStageKey`. */
  first: string;
}

/**
 * The synchronous core, for a caller that already holds resolved stages — the
 * benchmark loop, which resolves many orgs at once and must not re-query per
 * org. `stages` must already be localized (`resolvePipelineStages` does it).
 */
export function outcomeStageKeysFrom(stages: ResolvedStage[]): OutcomeStageKeys {
  const byOrder = [...stages].sort((a, b) => a.order - b.order);
  const onPath = byOrder.filter((s) => !s.isOffPath);
  const anchor =
    onPath.find((s) => (CANONICAL_OUTCOME_KEYS as readonly string[]).includes(s.key)) ??
    onPath[onPath.length - 1];

  return {
    finished: anchor ? onPath.filter((s) => s.order >= anchor.order).map((s) => s.key) : [],
    finishedLabel: anchor?.label ?? '',
    // `isDefaultLabel` matches a built-in label in ANY locale, which is exactly
    // right here: a stage nobody renamed resolves to one of our own strings, a
    // renamed one does not, and a custom KEY has no built-in label at all.
    finishedLabelIsCustom: anchor ? !isDefaultLabel(anchor.key, anchor.label) : false,
    offPath: byOrder.filter((s) => s.isOffPath).map((s) => s.key),
    first: startStageKey(stages),
  };
}
