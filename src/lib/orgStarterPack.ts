// The tenant starter pack (#2066): a new organization's stages, service levels,
// document requirements, evaluation framework and goal templates in one go, so
// the configuration depth the product has is the fastest onboarding instead of
// five empty editors.
//
// WHAT IT REUSES — nothing here invents a second catalogue
//   • Stages (and, where a template carries them, service levels and document
//     requirements) come from the programme template catalogue (#1641,
//     src/lib/programTemplates.ts): the vertical's default template, else the
//     canonical set — which that module derives from the PipelineStatus enum,
//     so no stage key is spelled out here (scripts/check-stage-keys.mjs, #1886).
//   • The canonical set carries no service levels of its own; the starter days
//     are given per position among its on-path, non-terminal stages (the unit
//     test pins that the two line up).
//
// THE TWO PROMISES
//   1. Idempotent. Applying twice changes nothing: every write is keyed on the
//      model's own unique key (`createMany({ skipDuplicates })`) or skipped when
//      the tenant already has one of its own. A label, a `days` value or a
//      criterion the tenant edited is never overwritten.
//   2. Composable. It takes an EXISTING orgId, never creates an organization,
//      and runs inside a caller's transaction when given one — the provisioning
//      wizard (#2065) and self-serve signup (#1749) call it right after they
//      create the org.
//
// Stages are only seeded for an org that has NONE: an org with its own stage
// rows has chosen its pipeline, and adding a second set beside it would leave
// two "first" stages.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { Locale } from '@/i18n/config';
import {
  defaultTemplateForVertical,
  programTemplate,
  templateStages,
  type LocalizedLabel,
  type ProgramTemplate,
  type TemplateDocumentRequirement,
} from '@/lib/programTemplates';

type Tx = Prisma.TransactionClient;

/**
 * Starter service levels for the canonical set, in calendar days, one per
 * on-path non-terminal stage in pipeline order: application, approval,
 * interview, introduction, internship starting, internship in progress (none —
 * its length is the internship's), internship completed, job seeking,
 * hireable, hired (none — the wait for a start date is the employer's).
 */
export const CANONICAL_SLA_DAYS: (number | null)[] = [7, 5, 10, 7, 14, null, 14, 60, 30, null];

/** Document requirements for a template that brings none of its own. */
export const STARTER_DOCUMENTS: TemplateDocumentRequirement[] = [
  { key: 'STARTER_CV', mandatory: true, labels: { en: 'CV', tr: 'Özgeçmiş', de: 'Lebenslauf' } },
  { key: 'STARTER_ENROLMENT', mandatory: true, labels: { en: 'Proof of enrolment', tr: 'Öğrenci belgesi', de: 'Immatrikulationsbescheinigung' } },
  { key: 'STARTER_AGREEMENT', mandatory: true, labels: { en: 'Signed programme agreement', tr: 'İmzalı program sözleşmesi', de: 'Unterschriebene Programmvereinbarung' } },
  { key: 'STARTER_NDA', mandatory: false, labels: { en: 'Confidentiality agreement', tr: 'Gizlilik sözleşmesi', de: 'Vertraulichkeitsvereinbarung' } },
];

export interface StarterCriterion {
  key: string;
  labels: LocalizedLabel;
}

/** One rubric per scope. The first keys are the built-in ones (src/lib/evaluation.ts), so history reads alike. */
export const STARTER_EVALUATION: Record<'MENTEE' | 'MENTOR', { name: string; criteria: StarterCriterion[] }> = {
  MENTEE: {
    name: 'Starter rubric — mentee',
    criteria: [
      { key: 'technical', labels: { en: 'Technical skills', tr: 'Teknik beceriler', de: 'Fachliche Fähigkeiten' } },
      { key: 'communication', labels: { en: 'Communication', tr: 'İletişim', de: 'Kommunikation' } },
      { key: 'reliability', labels: { en: 'Reliability', tr: 'Güvenilirlik', de: 'Zuverlässigkeit' } },
      { key: 'growth', labels: { en: 'Growth', tr: 'Gelişim', de: 'Entwicklung' } },
      { key: 'teamwork', labels: { en: 'Teamwork', tr: 'Takım çalışması', de: 'Teamarbeit' } },
      { key: 'initiative', labels: { en: 'Initiative', tr: 'İnisiyatif', de: 'Eigeninitiative' } },
    ],
  },
  MENTOR: {
    name: 'Starter rubric — mentor',
    criteria: [
      { key: 'guidance', labels: { en: 'Guidance', tr: 'Yol göstericilik', de: 'Orientierung' } },
      { key: 'availability', labels: { en: 'Availability', tr: 'Ulaşılabilirlik', de: 'Erreichbarkeit' } },
      { key: 'expertise', labels: { en: 'Expertise', tr: 'Uzmanlık', de: 'Fachwissen' } },
      { key: 'support', labels: { en: 'Support', tr: 'Destek', de: 'Unterstützung' } },
      { key: 'feedback', labels: { en: 'Constructive feedback', tr: 'Yapıcı geri bildirim', de: 'Konstruktives Feedback' } },
    ],
  },
};

/** Goal templates, house style of the shared pool: `title` is the Turkish wording, all three in `translations`. */
export const STARTER_GOALS: LocalizedLabel[] = [
  { tr: 'İlk görüşmede bu dönemin üç hedefini birlikte yaz', en: 'Write down three goals for this term together in the first meeting', de: 'Im ersten Treffen gemeinsam drei Ziele für diese Phase festhalten' },
  { tr: 'Haftalık görüşme ritmini belirle ve takvime ekle', en: 'Agree on a weekly meeting rhythm and put it in the calendar', de: 'Einen wöchentlichen Gesprächsrhythmus vereinbaren und eintragen' },
  { tr: 'Özgeçmişini güncelle ve geri bildirim iste', en: 'Update your CV and ask for feedback on it', de: 'Den Lebenslauf aktualisieren und um Feedback bitten' },
  { tr: 'Hedef rolün için bir ilanı birlikte incele', en: 'Go through one job posting for your target role together', de: 'Gemeinsam eine Stellenanzeige für die Zielrolle durchgehen' },
  { tr: 'Bir prova mülakat yap ve notları paylaş', en: 'Hold a mock interview and share the notes', de: 'Ein Probeinterview führen und die Notizen teilen' },
  { tr: 'Dönem sonunda neyin işe yaradığını birlikte değerlendir', en: 'Review together at the end of the term what worked', de: 'Am Ende der Phase gemeinsam auswerten, was funktioniert hat' },
];

export type StarterModel = 'stages' | 'slas' | 'documentRequirements' | 'evaluationTemplates' | 'goalTemplates';
export type StarterSummary = Record<StarterModel, { created: number; skipped: number }> & {
  /** Present when the sample programme was asked for (#2066). */
  sampleProgram?: { created: number; skipped: number };
};

/** The template a tenant's starter pack is drawn from. */
export function starterTemplate(vertical: string | null | undefined): ProgramTemplate {
  return (vertical ? defaultTemplateForVertical(vertical) : null) ?? programTemplate('canonical_pipeline')!;
}

/** The starter service levels for a template: its own, or the canonical days by position. */
export function starterSlas(template: ProgramTemplate): { stageKey: string; days: number }[] {
  if (template.slas.length > 0) return template.slas.map((s) => ({ stageKey: s.stageKey, days: s.days }));
  const onPath = templateStages(template).filter((s) => !s.isTerminal && !s.isOffPath);
  return onPath.flatMap((s, i) => (CANONICAL_SLA_DAYS[i] ? [{ stageKey: s.key, days: CANONICAL_SLA_DAYS[i]! }] : []));
}

async function apply(tx: Tx, orgId: string, locale: Locale, sampleProgram: boolean): Promise<StarterSummary> {
  const org = await tx.organization.findUnique({ where: { id: orgId }, select: { id: true, vertical: true } });
  if (!org) throw new Error(`applyOrgStarterPack: no organization ${orgId}`);
  const template = starterTemplate(org.vertical);
  const summary = {} as StarterSummary;

  // Stages — only for an org that has none of its own.
  const stages = templateStages(template, locale);
  const ownStages = await tx.pipelineStage.count({ where: { orgId } });
  if (ownStages === 0) {
    const r = await tx.pipelineStage.createMany({
      data: stages.map((s) => ({ orgId, key: s.key, label: s.label, order: s.order, isTerminal: s.isTerminal, isOffPath: s.isOffPath, color: s.color })),
      skipDuplicates: true,
    });
    summary.stages = { created: r.count, skipped: stages.length - r.count };
  } else {
    summary.stages = { created: 0, skipped: stages.length };
  }

  // Service levels — only for stages the org actually has; an existing row
  // (the tenant's own days) is never touched.
  const orgStageKeys = new Set(ownStages === 0 ? stages.map((s) => s.key) : (await tx.pipelineStage.findMany({ where: { orgId }, select: { key: true } })).map((s) => s.key));
  const slas = starterSlas(template).filter((s) => orgStageKeys.has(s.stageKey));
  const slaResult = slas.length ? await tx.stageSla.createMany({ data: slas.map((s) => ({ orgId, stageKey: s.stageKey, days: s.days })), skipDuplicates: true }) : { count: 0 };
  summary.slas = { created: slaResult.count, skipped: slas.length - slaResult.count };

  // Document requirements — keyed on (orgId, key).
  const docs = template.documentRequirements?.length ? template.documentRequirements : STARTER_DOCUMENTS;
  const docResult = await tx.documentRequirement.createMany({
    data: docs.map((d, order) => ({
      orgId,
      key: d.key,
      labels: d.labels,
      appliesToStage: d.appliesToStage && orgStageKeys.has(d.appliesToStage) ? d.appliesToStage : null,
      mandatory: d.mandatory,
      order,
    })),
    skipDuplicates: true,
  });
  summary.documentRequirements = { created: docResult.count, skipped: docs.length - docResult.count };

  // Evaluation framework — one per scope, and none where the tenant already has
  // a framework for that scope (adding a second would change which rubric is in force).
  let evalCreated = 0;
  for (const scope of ['MENTEE', 'MENTOR'] as const) {
    if (await tx.evaluationTemplate.count({ where: { orgId, scope } })) continue;
    const spec = STARTER_EVALUATION[scope];
    await tx.evaluationTemplate.create({
      data: { orgId, scope, name: spec.name, criteria: { create: spec.criteria.map((c, order) => ({ key: c.key, labels: c.labels, order })) } },
    });
    evalCreated++;
  }
  summary.evaluationTemplates = { created: evalCreated, skipped: 2 - evalCreated };

  // Goal templates — the org's own pool (projectId null). `@@unique([projectId,
  // title])` does not hold across NULL projectIds in MySQL, so the title is
  // checked here, exactly as prisma/seed-goal-templates.mjs does.
  const existing = new Set((await tx.projectTaskTemplate.findMany({ where: { orgId, projectId: null }, select: { title: true } })).map((t) => t.title));
  const goals = STARTER_GOALS.filter((g) => !existing.has(g.tr));
  if (goals.length) await tx.projectTaskTemplate.createMany({ data: goals.map((g) => ({ orgId, projectId: null, title: g.tr, translations: g })) });
  summary.goalTemplates = { created: goals.length, skipped: STARTER_GOALS.length - goals.length };

  // The sample programme, after the stages exist, in the same transaction.
  // Loaded only when asked for: it pulls in the account-erasure path, which
  // this module (and its unit test) has no other reason to load.
  if (sampleProgram) {
    const { createSampleProgram } = await import('@/lib/orgSampleProgram');
    summary.sampleProgram = await createSampleProgram(tx, orgId);
  }

  return summary;
}

/**
 * Apply the starter pack to an existing organization. One transaction — the
 * caller's when given (`tx`), else its own. Returns per-model counts.
 */
export async function applyOrgStarterPack(orgId: string, opts: { tx?: Tx; locale?: Locale; sampleProgram?: boolean } = {}): Promise<StarterSummary> {
  const locale = opts.locale ?? 'en';
  const sample = opts.sampleProgram === true;
  if (opts.tx) return apply(opts.tx, orgId, locale, sample);
  return prisma.$transaction((tx) => apply(tx, orgId, locale, sample), { timeout: 30_000 });
}
