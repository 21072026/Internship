import { test, expect } from '@playwright/test';
import {
  PROGRAM_TEMPLATES,
  TEMPLATE_LOCALES,
  programTemplate,
  programTemplateCopy,
  templateApplyBlockers,
  templateStagePayload,
  templateStages,
  validateProgramTemplate,
  validateProgramTemplates,
  type ProgramTemplate,
} from '@/lib/programTemplates';
import { dictionaries } from '@/i18n/dictionaries';
import { startStageKey } from '@/lib/pipeline';

// Programme template catalogue (#1641) — pure guards, no browser, no database.
//
// A malformed template is invisible until an admin applies it: the editor
// endpoint answers 400 and the wizard has already promised the shape would
// work. These assertions make that a red build instead, which is the whole
// reason `validateProgramTemplate()` exists.

test('every template in the catalogue is well-formed', { tag: '@smoke' }, async () => {
  expect(validateProgramTemplates()).toEqual([]);
  // Four curated shapes plus the canonical set the product ships with.
  expect(PROGRAM_TEMPLATES.length).toBeGreaterThanOrEqual(5);
  for (const key of ['graduate_internship', 'onboarding_buddy', 'leadership_cohort', 'career_transition']) {
    expect(programTemplate(key), `${key} is in the catalogue`).not.toBeNull();
  }
  expect(programTemplate('no_such_template')).toBeNull();
  expect(programTemplate(null)).toBeNull();
});

test('each curated template is its own shape, not a relabelled canonical set', async () => {
  const canonical = programTemplate('canonical_pipeline')!;
  const canonicalKeys = new Set(canonical.stages.map((s) => s.key));

  for (const template of PROGRAM_TEMPLATES.filter((t) => t.key !== 'canonical_pipeline')) {
    // 5-8 stages: a set you cannot read at a glance is a spreadsheet.
    expect(template.stages.length, `${template.key} stage count`).toBeGreaterThanOrEqual(5);
    expect(template.stages.length, `${template.key} stage count`).toBeLessThanOrEqual(8);
    // No curated template reuses a canonical key — that is what makes it a
    // different shape rather than a rename, and it keeps the default keys out
    // of this file (scripts/check-stage-keys.mjs, #1886).
    for (const stage of template.stages) {
      expect(canonicalKeys.has(stage.key), `${template.key}/${stage.key} is not a canonical key`).toBe(false);
    }
    // Somewhere to start, somewhere to finish, and a way to leave.
    expect(template.stages.some((s) => !s.isOffPath && s.isTerminal)).toBe(true);
    expect(template.stages.some((s) => s.isOffPath)).toBe(true);
    // Each carries its own cadence and its own service levels.
    expect(template.reminderDays).toBeGreaterThan(0);
    expect(template.slas.length).toBeGreaterThan(0);
  }
});

test('every template name and description exists in all three languages', async () => {
  for (const locale of TEMPLATE_LOCALES) {
    for (const template of PROGRAM_TEMPLATES) {
      const copy = programTemplateCopy(dictionaries[locale], template.key);
      expect(copy, `${template.key} has ${locale} copy`).not.toBeNull();
      expect(copy!.name.trim().length).toBeGreaterThan(0);
      expect(copy!.desc.trim().length).toBeGreaterThan(0);
    }
  }
  // …and the three languages really are different text, not one copied thrice.
  const names = TEMPLATE_LOCALES.map((l) => programTemplateCopy(dictionaries[l], 'graduate_internship')!.name);
  expect(new Set(names).size).toBe(TEMPLATE_LOCALES.length);
});

test('a malformed template is reported, not silently shipped', async () => {
  const base = programTemplate('onboarding_buddy')!;
  const clone = (patch: (t: ProgramTemplate) => ProgramTemplate): ProgramTemplate =>
    patch(JSON.parse(JSON.stringify(base)) as ProgramTemplate);

  // A key the editor endpoint's regex would refuse with a 400.
  expect(
    validateProgramTemplate(clone((t) => { t.stages[0].key = 'BUDDY PAIRED'; return t; })).join(' ')
  ).toContain('must be [A-Za-z0-9_]');

  // Two stages with the same key.
  expect(
    validateProgramTemplate(clone((t) => { t.stages[1].key = t.stages[0].key; return t; })).join(' ')
  ).toContain('duplicate stage key');

  // Two on-path stages tied for first: the starting stage of a new relation
  // would depend on array order rather than on the template.
  expect(
    validateProgramTemplate(clone((t) => { t.stages[1].order = t.stages[0].order; return t; })).join(' ')
  ).toContain('first on-path stage');

  // An SLA pointing at a stage that is not in the set.
  expect(
    validateProgramTemplate(clone((t) => { t.slas[0].stageKey = 'BUDDY_NOWHERE'; return t; })).join(' ')
  ).toContain('unknown stage');

  // A missing translation — the picker promises all three languages.
  expect(
    validateProgramTemplate(clone((t) => { t.stages[0].labels.de = '   '; return t; })).join(' ')
  ).toContain('no de label');

  // Nobody can ever finish.
  expect(
    validateProgramTemplate(clone((t) => { t.stages.forEach((s) => { s.isTerminal = false; }); return t; })).join(' ')
  ).toContain('terminal on-path stage');
});

test('a template resolves to the editor payload, in the reader’s language', async () => {
  const template = programTemplate('graduate_internship')!;

  const en = templateStagePayload(template, 'en');
  const tr = templateStagePayload(template, 'tr');
  // Same keys and the same order in every language; only the labels change.
  expect(tr.stages.map((s) => s.key)).toEqual(en.stages.map((s) => s.key));
  expect(en.stages.map((s) => s.order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(en.stages[0].label).toBe('Applied');
  expect(tr.stages[0].label).toBe('Başvurdu');
  expect(templateStagePayload(template, 'de').stages[0].label).toBe('Beworben');

  // A new relation starts on the template's first on-path stage, resolved by
  // the same helper the app uses for a live tenant.
  expect(startStageKey(templateStages(template, 'en'))).toBe('GRAD_APPLIED');
});

test('applying over a running programme is refused, and replacing one asks first', async () => {
  const template = programTemplate('career_transition')!;

  // A fresh programme: nothing customised, nobody in the pipeline.
  expect(templateApplyBlockers(template, { existingStageCount: 0, occupiedStageKeys: [] })).toEqual([]);

  // Stages already customised — the editor endpoint replaces the set with
  // deleteMany + createMany, so this needs an explicit confirmation.
  expect(templateApplyBlockers(template, { existingStageCount: 7, occupiedStageKeys: [] }))
    .toEqual(['unconfirmed_replace']);
  expect(templateApplyBlockers(template, { existingStageCount: 7, occupiedStageKeys: [], confirmed: true }))
    .toEqual([]);

  // Someone is sitting on a stage the template does not have. Confirmation does
  // NOT unlock this one: their pipelineStatus would point at a stage that no
  // longer exists — no board column, no funnel row, no way out (#1634).
  expect(
    templateApplyBlockers(template, {
      existingStageCount: 0,
      occupiedStageKeys: ['SOME_OTHER_STAGE'],
      confirmed: true,
    })
  ).toContain('stranded_relations');

  // Relations already on this template's own stages are fine — nothing strands.
  expect(
    templateApplyBlockers(template, { existingStageCount: 0, occupiedStageKeys: ['SWITCH_APPLYING'] })
  ).toEqual([]);
});
