import { test, expect, type APIRequestContext } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'crypto';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { defaultTemplateForVertical, templateStagePayload, templateSlaPayload } from '../src/lib/programTemplates';

// The two MARKETING operator CLIs (#2959), against a real database:
//
//   prisma/apply-marketing-stage-preset.mjs
//     • a dry run writes nothing;
//     • --apply brings a pre-#2840 stage set to exactly the current preset
//       (stages + service levels), and a second run has nothing to do;
//     • a retired key that a record still sits on refuses the whole run;
//     • an org that is not MARKETING is refused.
//
//   prisma/wipe-integration-source.mjs — the rollback
//     • a dry run writes nothing;
//     • --apply deletes exactly what the dry run counted, table by table;
//     • it takes only what the source CREATED (Company.createdBySource): a
//       manual account the source merely moved, an account another source
//       created and the same source's accounts in ANOTHER org all survive;
//     • an account a person worked on is kept, with the reason — an interaction,
//       a win-back that only left an activity entry, a value a person typed,
//       the lead's own contact-permission withdrawal; a mere read is not work;
//     • the events and entries of a kept or merely moved account stay.
//
// The events reach the database through the real route
// (POST /api/integrations/<slug>/events), so the marker under test is the one
// the account-event writer actually stamps. Synthetic data only.

const execFileAsync = promisify(execFile);
const STAMP = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const SLUG = `e2e-wipe-${STAMP}`;
const OTHER_SLUG = `e2e-keep-${STAMP}`;
const KEY_PREFIX = `e2e-ops-clis-${STAMP}`;
const DAY = 24 * 60 * 60 * 1000;

async function cli(script: string, args: string[]) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [`prisma/${script}`, ...args, '--json'], {
      cwd: process.cwd(),
      env: process.env,
    });
    return { code: 0, json: JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    const last = (err.stdout ?? '').trim().split('\n').at(-1);
    return { code: err.code ?? 1, json: last ? JSON.parse(last) : null, stderr: err.stderr ?? '' };
  }
}

async function org(label: string, vertical: 'MARKETING' | 'INTERNSHIP' = 'MARKETING') {
  return prisma.organization.create({
    data: { name: `Ops CLIs ${label} ${STAMP}`, slug: `ops-clis-${label}-${STAMP}`, ...(vertical === 'MARKETING' ? { vertical } : {}) },
    select: { id: true, slug: true },
  });
}

const orgIds: string[] = [];
test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  const where = { orgId: { in: orgIds } };
  await prisma.interactionLog.deleteMany({ where: { relation: where } });
  await prisma.integrationEvent.deleteMany({ where });
  await prisma.integrationSource.deleteMany({ where });
  await prisma.statusChange.deleteMany({ where: { relation: where } });
  await prisma.mentorshipRelation.updateMany({ where, data: { previousRelationId: null } });
  await prisma.mentorshipRelation.deleteMany({ where });
  await prisma.company.deleteMany({ where });
  await prisma.user.deleteMany({ where });
  await prisma.source.deleteMany({ where });
  await prisma.setting.deleteMany({ where });
  await prisma.stageSla.deleteMany({ where });
  await prisma.apiKey.deleteMany({ where: { name: { startsWith: KEY_PREFIX } } });
  await prisma.activityLog.deleteMany({ where });
  await prisma.pipelineStage.deleteMany({ where });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.$disconnect();
});

// ── apply-marketing-stage-preset ─────────────────────────────────────────────

const preset = defaultTemplateForVertical('MARKETING')!;
const OLD_SET = [
  { key: 'LEAD_NEW', label: 'New lead', order: 0, isTerminal: false, isOffPath: false, color: '#2563eb' },
  { key: 'LEAD_CONTACTED', label: 'Contacted', order: 1, isTerminal: false, isOffPath: false, color: '#0ea5e9' },
  { key: 'LEAD_QUALIFIED', label: 'Qualified', order: 2, isTerminal: false, isOffPath: false, color: '#8b5cf6' },
  { key: 'DEAL_PROPOSAL', label: 'Proposal sent', order: 3, isTerminal: false, isOffPath: false, color: '#f59e0b' },
  { key: 'DEAL_NEGOTIATION', label: 'Negotiation', order: 4, isTerminal: false, isOffPath: false, color: '#f97316' },
  { key: 'DEAL_WON', label: 'Won', order: 5, isTerminal: true, isOffPath: false, color: '#16a34a' },
  { key: 'DEAL_LOST', label: 'Lost', order: 6, isTerminal: true, isOffPath: true, color: '#6b7280' },
];

const stageRows = (orgId: string) =>
  prisma.pipelineStage.findMany({
    where: { orgId },
    orderBy: { order: 'asc' },
    select: { key: true, label: true, order: true, isTerminal: true, isOffPath: true, color: true, updatedAt: true },
  });
const slaRows = (orgId: string) =>
  prisma.stageSla.findMany({ where: { orgId }, orderBy: { stageKey: 'asc' }, select: { stageKey: true, days: true, wipLimit: true } });

async function oldSetOrg(label: string) {
  const o = await org(label);
  orgIds.push(o.id);
  await prisma.pipelineStage.createMany({ data: OLD_SET.map((s) => ({ ...s, orgId: o.id })) });
  const owner = await seedUser(uniqueEmail(`ops-owner-${label}`), 'OwnerPass123!', 'MENTOR', 'Ops Owner', o.id);
  const lead = await seedUser(uniqueEmail(`ops-lead-${label}`), 'LeadPass123!', 'MENTEE', 'Ops Lead', o.id);
  return { ...o, ownerId: owner.id, leadId: lead.id };
}

test('stage preset: a dry run writes nothing, --apply lands exactly the preset, a second run is a no-op', async () => {
  const o = await oldSetOrg('preset');
  await prisma.mentorshipRelation.create({ data: { orgId: o.id, mentorId: o.ownerId, menteeId: o.leadId, pipelineStatus: 'LEAD_NEW' } });
  await prisma.stageSla.create({ data: { orgId: o.id, stageKey: 'LEAD_NEW', days: 2, wipLimit: 9 } });

  const before = { stages: await stageRows(o.id), slas: await slaRows(o.id) };
  const dry = await cli('apply-marketing-stage-preset.mjs', ['--org', o.slug]);
  expect(dry.code).toBe(0);
  expect(dry.json.written).toBe(false);
  expect(dry.json.removals.map((r: { key: string }) => r.key)).toEqual(['DEAL_PROPOSAL', 'DEAL_NEGOTIATION']);
  expect({ stages: await stageRows(o.id), slas: await slaRows(o.id) }).toEqual(before);

  const applied = await cli('apply-marketing-stage-preset.mjs', ['--org', o.id, '--apply']);
  expect(applied.code).toBe(0);
  expect(applied.json.written).toBe(true);
  expect(applied.json.changes).toBe(dry.json.changes);

  const after = (await stageRows(o.id)).map(({ updatedAt: _u, ...s }) => s);
  expect(after).toEqual(templateStagePayload(preset, 'en').stages);
  const wantSlas = templateSlaPayload(preset)
    .slas.filter((s) => s.days != null)
    .map((s) => ({ stageKey: s.stageKey, days: s.days, wipLimit: s.stageKey === 'LEAD_NEW' ? 9 : null }))
    .sort((a, b) => a.stageKey.localeCompare(b.stageKey));
  expect(await slaRows(o.id)).toEqual(wantSlas);
  // The record never left its stage.
  expect(await prisma.mentorshipRelation.count({ where: { orgId: o.id, pipelineStatus: 'LEAD_NEW' } })).toBe(1);

  const again = await cli('apply-marketing-stage-preset.mjs', ['--org', o.slug, '--apply']);
  expect(again.code).toBe(0);
  expect(again.json.changes).toBe(0);
  expect(again.json.written).toBe(false);
});

test('stage preset: a retired key in use refuses the run and writes nothing; a non-MARKETING org is refused', async () => {
  const o = await oldSetOrg('refused');
  await prisma.mentorshipRelation.create({ data: { orgId: o.id, mentorId: o.ownerId, menteeId: o.leadId, pipelineStatus: 'DEAL_PROPOSAL' } });
  await prisma.stageSla.create({ data: { orgId: o.id, stageKey: 'DEAL_NEGOTIATION', days: 7 } });
  const before = { stages: await stageRows(o.id), slas: await slaRows(o.id) };

  const refused = await cli('apply-marketing-stage-preset.mjs', ['--org', o.slug, '--apply']);
  expect(refused.code).toBe(1);
  expect(refused.json.written).toBe(false);
  expect(refused.json.blockers).toEqual([
    { key: 'DEAL_NEGOTIATION', reason: 'stale_slas', days: 7, wipLimit: null },
    { key: 'DEAL_PROPOSAL', reason: 'stranded_relations', count: 1 },
  ]);
  expect({ stages: await stageRows(o.id), slas: await slaRows(o.id) }).toEqual(before);

  const internship = await org('internship', 'INTERNSHIP');
  orgIds.push(internship.id);
  const notMarketing = await cli('apply-marketing-stage-preset.mjs', ['--org', internship.slug, '--apply']);
  expect(notMarketing.code).toBe(1);
  expect(notMarketing.stderr).toContain('not a MARKETING tenant');
  expect(await prisma.pipelineStage.count({ where: { orgId: internship.id } })).toBe(0);
});

// ── wipe-integration-source ──────────────────────────────────────────────────

async function mintKey(orgId: string): Promise<string> {
  const raw = `icrm_${randomBytes(24).toString('hex')}`;
  await prisma.apiKey.create({
    data: { name: `${KEY_PREFIX}-${randomBytes(3).toString('hex')}`, hashedKey: createHash('sha256').update(raw).digest('hex'), scopes: 'companies:write', orgId },
  });
  return raw;
}

async function feedOrg(label: string) {
  const o = await org(label);
  orgIds.push(o.id);
  await prisma.pipelineStage.createMany({ data: templateStagePayload(preset).stages.map((s) => ({ ...s, orgId: o.id })) });
  const owner = await seedUser(uniqueEmail(`wipe-owner-${label}`), 'OwnerPass123!', 'MENTOR', 'Wipe Owner', o.id);
  await prisma.setting.create({ data: { orgId: o.id, key: 'defaultLeadOwnerId', value: owner.id } });
  await prisma.integrationSource.createMany({
    data: [
      { orgId: o.id, slug: SLUG, label: 'Wipe Feed' },
      { orgId: o.id, slug: OTHER_SLUG, label: 'Other Feed' },
    ],
  });
  return { ...o, ownerId: owner.id, key: await mintKey(o.id) };
}

let n = 0;
function event(externalId: string, over: Record<string, unknown> = {}) {
  n += 1;
  return {
    event_id: `evt-${STAMP}-${n}`,
    schema_version: 1,
    event_type: 'account_created',
    occurred_at: new Date(Date.now() - DAY + n * 1000).toISOString(),
    external_id: externalId,
    trial_started_at: new Date(Date.now() - DAY).toISOString(),
    trial_ends_at: new Date(Date.now() + 29 * DAY).toISOString(),
    contact: { first_name: 'Wanda', last_name: `Wipe ${n}`, email: `wanda-${n}-${STAMP}@shop.example.test`, company_name: `Acme Sales ${n} ${STAMP}` },
    ...over,
  };
}

async function send(request: APIRequestContext, key: string, slug: string, body: unknown) {
  const res = await request.post(`/api/integrations/${slug}/events`, { headers: { authorization: `Bearer ${key}` }, data: body });
  expect(res.status(), JSON.stringify(await res.json())).toBe(200);
  return res.json();
}

/** Row counts of one org, per table the rollback touches. */
async function snapshot(orgId: string) {
  const companyIds = (await prisma.company.findMany({ where: { orgId }, select: { id: true } })).map((c) => c.id);
  return {
    companies: companyIds.length,
    relations: await prisma.mentorshipRelation.count({ where: { orgId } }),
    statusChanges: await prisma.statusChange.count({ where: { relation: { orgId } } }),
    users: await prisma.user.count({ where: { orgId } }),
    contactPermissions: await prisma.contactPermission.count({ where: { companyId: { in: companyIds } } }),
    companyChannels: await prisma.companyChannel.count({ where: { companyId: { in: companyIds } } }),
    activityLogs: await prisma.activityLog.count({ where: { orgId } }),
    integrationEvents: await prisma.integrationEvent.count({ where: { orgId } }),
  };
}

test('wipe: the dry run writes nothing, --apply deletes exactly what it counted and only what the source created', async ({ request }) => {
  const a = await feedOrg('wipe-a');
  const b = await feedOrg('wipe-b');

  // Created by SLUG in org A: a full account (then won), an account alone, and
  // one a person then worked on.
  const full = await send(request, a.key, SLUG, event(`ext-full-${STAMP}`));
  expect(full.outcome).toBe('applied');
  expect((await send(request, a.key, SLUG, event(`ext-full-${STAMP}`, { event_type: 'converted' }))).outcome).toBe('applied');
  const alone = await send(request, a.key, SLUG, event(`ext-alone-${STAMP}`, { contact: null }));
  expect(alone.relationId).toBeUndefined();
  const worked = await send(request, a.key, SLUG, event(`ext-worked-${STAMP}`));
  await prisma.interactionLog.create({ data: { relationId: worked.relationId, type: 'Meeting', date: new Date(), notes: 'A call a person logged' } });
  // Work that leaves no row in a record table: a person's win-back (only an
  // actor-attributed activity entry, in the lowercase spelling the route
  // writes), a deal value a person typed, and the lead's own withdrawal of
  // contact permission (the legal evidence).
  const wonBack = await send(request, a.key, SLUG, event(`ext-wonback-${STAMP}`));
  await prisma.activityLog.create({
    data: { orgId: a.id, action: 'pipeline.win_back', actorId: a.ownerId, targetType: 'relation', targetId: wonBack.relationId, detail: 'by a person' },
  });
  const valued = await send(request, a.key, SLUG, event(`ext-valued-${STAMP}`));
  await prisma.relationValue.create({ data: { orgId: a.id, relationId: valued.relationId, valueMinor: 4900, source: 'MANUAL', updatedById: a.ownerId } });
  const withdrawn = await send(request, a.key, SLUG, event(`ext-withdrawn-${STAMP}`));
  const withdrawnPermission = await prisma.contactPermission.updateMany({
    where: { companyId: withdrawn.companyId },
    data: { revokedAt: new Date(), revokedVia: 'LINK' },
  });
  expect(withdrawnPermission.count).toBe(1);
  // Reading an account is not work: a person's view entry does not keep `full`.
  await prisma.activityLog.create({
    data: { orgId: a.id, action: 'company.view', actorId: a.ownerId, targetType: 'company', targetId: full.companyId },
  });
  // Record-only and unknown-account events of SLUG.
  await send(request, a.key, SLUG, event(`ext-full-${STAMP}`, { event_type: 'plan_changed' }));
  expect((await send(request, a.key, SLUG, event(`ext-nobody-${STAMP}`, { event_type: 'converted' }))).outcome).toBe('unknown_account');

  // A manual account (no marker) that SLUG only MOVED.
  const manual = await prisma.company.create({ data: { orgId: a.id, name: `Acme Sales Manual ${STAMP}`, externalId: `ext-manual-${STAMP}` } });
  const manualLead = await seedUser(uniqueEmail('wipe-manual-lead'), 'LeadPass123!', 'MENTEE', 'Manual Lead', a.id);
  const manualRel = await prisma.mentorshipRelation.create({
    data: { orgId: a.id, mentorId: a.ownerId, menteeId: manualLead.id, companyId: manual.id, pipelineStatus: 'LEAD_QUALIFIED' },
  });
  expect((await send(request, a.key, SLUG, event(`ext-manual-${STAMP}`))).outcome).toBe('applied');

  // Another source of org A, and the same slug in org B.
  const other = await send(request, a.key, OTHER_SLUG, event(`ext-other-${STAMP}`));
  const foreign = await send(request, b.key, SLUG, event(`ext-foreign-${STAMP}`));

  const marker = await prisma.company.findMany({ where: { orgId: a.id, createdBySource: SLUG }, select: { id: true } });
  const keptIds = [worked.companyId, wonBack.companyId, valued.companyId, withdrawn.companyId];
  expect(marker.map((c) => c.id).sort()).toEqual([full.companyId, alone.companyId, ...keptIds].sort());
  expect((await prisma.company.findUniqueOrThrow({ where: { id: manual.id } })).createdBySource).toBeNull();

  const beforeA = await snapshot(a.id);
  const beforeB = await snapshot(b.id);

  const dry = await cli('wipe-integration-source.mjs', ['--org', a.slug, '--source', SLUG]);
  expect(dry.code).toBe(0);
  expect(await snapshot(a.id)).toEqual(beforeA);
  const verdicts = Object.fromEntries(dry.json.accounts.map((x: { companyId: string; action: string }) => [x.companyId, x]));
  expect(verdicts[full.companyId].action).toBe('wipe');
  expect(verdicts[alone.companyId].action).toBe('wipe');
  expect(verdicts[worked.companyId].action).toBe('keep');
  expect(verdicts[worked.companyId].reasons).toEqual(['interactionLog: 1']);
  expect(verdicts[wonBack.companyId]).toMatchObject({ action: 'keep', reasons: ['activityByPerson: 1'] });
  expect(verdicts[valued.companyId]).toMatchObject({ action: 'keep', reasons: ['relationValueByPerson: 1'] });
  expect(verdicts[withdrawn.companyId]).toMatchObject({ action: 'keep', reasons: ['contactPermissionEvidence: 1'] });
  expect(dry.json.touchedNotCreated).toEqual([manual.id]);
  expect(dry.json.totals.companies).toBe(2);
  expect(dry.json.totals.relations).toBe(1);
  expect(dry.json.totals.statusChanges).toBe(1);
  expect(dry.json.totals.leadUsers).toBe(1);

  const applied = await cli('wipe-integration-source.mjs', ['--org', a.id, '--source', SLUG, '--apply']);
  expect(applied.code).toBe(0);
  expect(applied.json.failed).toEqual([]);
  expect(applied.json.deleted).toEqual(dry.json.totals);

  // Every table moved by exactly what was counted; org B did not move at all.
  const afterA = await snapshot(a.id);
  const t = dry.json.totals;
  expect(afterA).toEqual({
    companies: beforeA.companies - t.companies,
    relations: beforeA.relations - t.relations,
    statusChanges: beforeA.statusChanges - t.statusChanges,
    users: beforeA.users - t.leadUsers,
    contactPermissions: beforeA.contactPermissions - t.contactPermissions,
    companyChannels: beforeA.companyChannels - t.companyChannels,
    activityLogs: beforeA.activityLogs - t.activityLogs,
    integrationEvents: beforeA.integrationEvents - t.integrationEvents,
  });
  expect(await snapshot(b.id)).toEqual(beforeB);

  // What must survive in org A.
  expect(await prisma.company.count({ where: { id: { in: [full.companyId, alone.companyId] } } })).toBe(0);
  expect(await prisma.company.count({ where: { id: { in: [...keptIds, manual.id, other.companyId] } } })).toBe(keptIds.length + 2);
  expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: manualRel.id } })).pipelineStatus).toBe('TRIAL_ACTIVE');
  expect(await prisma.user.count({ where: { id: manualLead.id } })).toBe(1);
  // The withdrawal is still on record, and so is the person's value.
  expect((await prisma.contactPermission.findFirstOrThrow({ where: { companyId: withdrawn.companyId } })).revokedVia).toBe('LINK');
  expect(await prisma.relationValue.count({ where: { relationId: valued.relationId } })).toBe(1);
  // The kept accounts and the account the source only moved keep their own
  // events (the evidence of what the source did to them); the source's events
  // that name no surviving account are gone; the other source's are untouched.
  const survivors = new Set([...keptIds, manual.id]);
  const left = await prisma.integrationEvent.findMany({ where: { orgId: a.id }, select: { provider: true, companyId: true, externalId: true } });
  const leftOfSlug = left.filter((e) => e.provider === SLUG);
  expect(leftOfSlug.every((e) => e.companyId !== null && survivors.has(e.companyId))).toBe(true);
  expect(leftOfSlug.some((e) => e.companyId === manual.id)).toBe(true);
  expect(left.filter((e) => e.provider === OTHER_SLUG)).toHaveLength(1);
  // The source's activity entries left are only those about a surviving account.
  const survivingExternalIds = new Set(
    (await prisma.company.findMany({ where: { id: { in: [...survivors] } }, select: { externalId: true } })).map((c) => c.externalId),
  );
  const survivingRelationIds = new Set(
    (await prisma.mentorshipRelation.findMany({ where: { companyId: { in: [...survivors] } }, select: { id: true } })).map((r) => r.id),
  );
  const slugEntries = await prisma.activityLog.findMany({
    where: { orgId: a.id, detail: { startsWith: `${SLUG}: ` } },
    select: { targetType: true, targetId: true },
  });
  for (const e of slugEntries) {
    const about = e.targetType === 'company_external_id' ? survivingExternalIds : survivingRelationIds;
    expect(about.has(e.targetId), JSON.stringify(e)).toBe(true);
  }
  expect(await prisma.company.count({ where: { id: foreign.companyId } })).toBe(1);

  // A second run finds only the kept accounts, and still lists the moved one.
  const again = await cli('wipe-integration-source.mjs', ['--org', a.slug, '--source', SLUG]);
  expect(again.json.accounts.map((x: { action: string }) => x.action)).toEqual(keptIds.map(() => 'keep'));
  expect(again.json.touchedNotCreated).toEqual([manual.id]);
  expect(again.json.totals).toEqual(Object.fromEntries(Object.keys(again.json.totals).map((k) => [k, 0])));
});
