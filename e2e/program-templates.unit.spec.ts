import { test, expect } from '@playwright/test';
import {
  PROGRAM_TEMPLATES,
  TEMPLATE_LOCALES,
  programTemplate,
  programTemplateCopy,
  templateApplyBlockers,
  staleSlaKeys,
  templateSlaPayload,
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

  // A label past the endpoint's `z.string().max(120)`. German is the realistic
  // trigger: it is the longest of the three locales and a compound stage name
  // overruns 120 easily — and a template that only fails in one language is
  // exactly the kind of 400 this validator exists to turn into a red build.
  expect(
    validateProgramTemplate(clone((t) => { t.stages[0].labels.de = 'A'.repeat(121); return t; })).join(' ')
  ).toContain('de label exceeds 120 chars');

  // An order past the endpoint's `z.number().int().min(0).max(1000)`.
  expect(
    validateProgramTemplate(clone((t) => { t.stages[0].order = 5000; return t; })).join(' ')
  ).toContain('order above 1000');
});

test('an unknown or prototype template key resolves to null, in both helpers', async () => {
  // `programTemplateCopy()` indexes a plain dictionary object, so a prototype
  // member name used to come back as an inherited function — a picker reading
  // ?template=toString would have rendered a template called "toString" and
  // then thrown on `copy.desc.trim()`. Both lookups must agree on null.
  for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'nope']) {
    expect(programTemplate(key), key).toBeNull();
    expect(programTemplateCopy(dictionaries.en, key), key).toBeNull();
  }
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
  const fresh = { existingStageCount: 0, occupiedStageKeys: [], configuredSlaKeys: [] };

  // A fresh programme: nothing customised, nobody in the pipeline, no SLAs.
  expect(templateApplyBlockers(template, fresh)).toEqual([]);

  // Stages already customised — the editor endpoint replaces the set with
  // deleteMany + createMany, so this needs an explicit confirmation.
  expect(templateApplyBlockers(template, { ...fresh, existingStageCount: 7 }))
    .toEqual(['unconfirmed_replace']);
  expect(templateApplyBlockers(template, { ...fresh, existingStageCount: 7, confirmed: true }))
    .toEqual([]);

  // Someone is sitting on a stage the template does not have. Confirmation does
  // NOT unlock this one: their pipelineStatus would point at a stage that no
  // longer exists — no board column, no funnel row, no way out (#1634).
  expect(
    templateApplyBlockers(template, {
      ...fresh,
      occupiedStageKeys: ['SOME_OTHER_STAGE'],
      confirmed: true,
    })
  ).toContain('stranded_relations');

  // Relations already on this template's own stages are fine — nothing strands.
  expect(templateApplyBlockers(template, { ...fresh, occupiedStageKeys: ['SWITCH_APPLYING'] })).toEqual([]);
});

test('a service level on a stage the template drops is refused before the swap', async () => {
  const template = programTemplate('graduate_internship')!;
  const fresh = { existingStageCount: 0, occupiedStageKeys: [], configuredSlaKeys: [] };

  // An org still on the BUILT-IN stages can already have configured service
  // levels — /api/admin/stage-sla resolves against the built-ins, so this needs
  // no custom stage at all. `StageSla.stageKey` has no foreign key, so that row
  // survives deleteMany + createMany; `resolveStageSlas()` then still returns a
  // non-empty map, `stageDeadlineUpdate()` reads the org as SLA-managed, and
  // every later stage move writes `stageDeadline: null` over a hand-typed date.
  // The row is unreachable from the SLA editor afterwards, so it has to be a
  // refusal here rather than a warning, and confirmation must not unlock it.
  const withOldSla = { ...fresh, configuredSlaKeys: ['APPLICATION_100'], confirmed: true };
  expect(templateApplyBlockers(template, withOldSla)).toContain('stale_slas');
  expect(staleSlaKeys(template, ['APPLICATION_100', 'GRAD_APPLIED'])).toEqual(['APPLICATION_100']);

  // Service levels that name stages the template keeps are not orphaned.
  expect(templateApplyBlockers(template, { ...fresh, configuredSlaKeys: ['GRAD_APPLIED'] })).toEqual([]);

  // And the template's own service levels have a payload to travel in — every
  // stage listed, null where the template sets no rule (that is how the SLA
  // route removes one), so no stale rule survives the apply.
  const payload = templateSlaPayload(template);
  expect(payload.slas.map((s) => s.stageKey)).toEqual(templateStages(template).map((s) => s.key));
  for (const sla of template.slas) {
    expect(payload.slas.find((s) => s.stageKey === sla.stageKey)?.days).toBe(sla.days);
  }
  const unmanaged = templateStages(template)
    .map((s) => s.key)
    .filter((k) => !template.slas.some((sla) => sla.stageKey === k));
  for (const key of unmanaged) {
    expect(payload.slas.find((s) => s.stageKey === key)?.days).toBeNull();
  }
});
