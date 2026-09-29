import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInAndSettle, gotoSettled, asHost, MARKETING_HOST, signInViaApi } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';
import { runMarketingAccountImport } from '../src/lib/marketingImportStore';

// The estimated monthly value of a funnel record (#2422, story #2393).
//
// What only a real server can show, and the unit tests cannot:
//   1. the rep edits the estimate on their own lead page, and it lands as an
//      INTEGER number of cents in its own row;
//   2. the lead on the record — who reads the relation itself — gets the value
//      neither from the relation payload (#1801) nor from the value route;
//   3. an ADMIN of the MARKETING tenant sees the monthly series on
//      /admin/analytics, rebuilt from StatusChange, and the editor on the shared
//      record page;
//   4. an INTERNSHIP tenant gets neither the route nor the card;
//   5. the two other write paths — a mentor transfer copies the row to the
//      successor in its own transaction, the account import gap-fills it —
//      really write RelationValue, and a cleared estimate on a transfer's
//      successor stays cleared in the series.
// The arithmetic itself (history, chains, currencies) is
// scripts/test/deal-value.test.mjs.

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'DealValue123!';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
const STAMP = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const repEmail = uniqueEmail(`dv-rep-${STAMP}`);
const adminEmail = uniqueEmail(`dv-admin-${STAMP}`);
const leadEmail = uniqueEmail(`dv-lead-${STAMP}`);
const wonLeadEmail = uniqueEmail(`dv-won-${STAMP}`);
const internMentorEmail = uniqueEmail(`dv-imentor-${STAMP}`);
const internMenteeEmail = uniqueEmail(`dv-imentee-${STAMP}`);
const rep2Email = uniqueEmail(`dv-rep2-${STAMP}`);
const handedEmail = uniqueEmail(`dv-handed-${STAMP}`);
const emails = [repEmail, adminEmail, leadEmail, wonLeadEmail, internMentorEmail, internMenteeEmail, rep2Email, handedEmail];

const ids: Record<string, string> = {};
let orgId = '';

/** 'YYYY-MM' of the month `back` months before the current one, UTC. */
function monthKey(back: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
/** The 10th of that month, noon UTC — safely inside it. */
function inMonth(back: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 10, 12));
}

test.beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Deal Value ${STAMP}`, slug: `deal-value-${STAMP}`, vertical: 'MARKETING' },
  });
  orgId = org.id;
  const preset = defaultTemplateForVertical('MARKETING')!;
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(preset).stages.map((s) => ({ ...s, orgId })),
  });
  const stageKeys = templateStagePayload(preset).stages;
  const won = stageKeys.find((s) => s.isTerminal && !s.isOffPath)!.key;
  const first = [...stageKeys].sort((a, b) => a.order - b.order)[0].key;
  const qualified = [...stageKeys].sort((a, b) => a.order - b.order)[1].key;

  const rep = await seedUser(repEmail, PASSWORD, 'MENTOR', `DV Rep ${STAMP}`, orgId);
  await seedUser(adminEmail, PASSWORD, 'ADMIN', `DV Admin ${STAMP}`, orgId);
  const lead = await seedUser(leadEmail, PASSWORD, 'MENTEE', `DV Lead ${STAMP}`, orgId);
  const wonLead = await seedUser(wonLeadEmail, PASSWORD, 'MENTEE', `DV Won ${STAMP}`, orgId);
  ids.leadId = lead.id;
  ids.qualifiedStage = qualified;

  // A chain-to-be: won last month, worth €70.00, with one logged interaction so
  // a transfer closes it and opens a successor (rather than fixing it in place).
  const rep2 = await seedUser(rep2Email, PASSWORD, 'MENTOR', `DV Rep2 ${STAMP}`, orgId);
  ids.rep2Id = rep2.id;
  const handed = await seedUser(handedEmail, PASSWORD, 'MENTEE', `DV Handed ${STAMP}`, orgId);
  const handedRel = await prisma.mentorshipRelation.create({
    data: { orgId, mentorId: rep.id, menteeId: handed.id, pipelineStatus: won, startDate: inMonth(3) },
  });
  ids.handedRelationId = handedRel.id;
  await prisma.statusChange.create({
    data: { relationId: handedRel.id, fromStatus: first, toStatus: won, changedById: rep.id, createdAt: inMonth(1) },
  });
  await prisma.interactionLog.create({
    data: { relationId: handedRel.id, date: inMonth(1), notes: 'Kick-off call', type: 'Meeting' },
  });
  await prisma.relationValue.create({ data: { relationId: handedRel.id, orgId, valueMinor: 7000, currency: 'EUR' } });

  const open = await prisma.mentorshipRelation.create({
    data: { orgId, mentorId: rep.id, menteeId: lead.id, pipelineStatus: qualified },
  });
  ids.openRelationId = open.id;

  // Won two months ago, worth €120.00 a month — but TODAY back on an earlier
  // stage would not matter: the series reads the recorded move, not the board.
  const wonRel = await prisma.mentorshipRelation.create({
    data: { orgId, mentorId: rep.id, menteeId: wonLead.id, pipelineStatus: won, startDate: inMonth(4) },
  });
  ids.wonRelationId = wonRel.id;
  await prisma.statusChange.create({
    data: { relationId: wonRel.id, fromStatus: first, toStatus: won, changedById: rep.id, createdAt: inMonth(2) },
  });
  await prisma.relationValue.create({ data: { relationId: wonRel.id, orgId, valueMinor: 12000, currency: 'EUR' } });

  // An INTERNSHIP pairing on the default world, for the "not here" half.
  const im = await seedUser(internMentorEmail, PASSWORD, 'MENTOR', `DV IMentor ${STAMP}`);
  const ie = await seedUser(internMenteeEmail, PASSWORD, 'MENTEE', `DV IMentee ${STAMP}`);
  const internRel = await prisma.mentorshipRelation.create({ data: { mentorId: im.id, menteeId: ie.id } });
  ids.internRelationId = internRel.id;
});

test.afterAll(async () => {
  await prisma.interactionLog.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  // What the import created: its lead (a stand-in address) and its account.
  const imported = await prisma.user.findMany({ where: { orgId, role: 'MENTEE' }, select: { id: true } });
  const importedIds = imported.map((u) => u.id);
  await prisma.statusChange.deleteMany({ where: { relation: { menteeId: { in: importedIds } } } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { menteeId: { in: importedIds } } }).catch(() => {});
  for (const email of emails) await cleanupByEmail(email);
  await prisma.user.deleteMany({ where: { id: { in: importedIds } } }).catch(() => {});
  await prisma.company.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

const onMarketing = { headers: asHost(MARKETING_HOST) };

async function apiAs(request: APIRequestContext, email: string, host?: string) {
  const signedIn = await signInViaApi(request, email, PASSWORD, host ? { host } : {});
  expect(signedIn.ok, `sign-in of ${email}: ${signedIn.error}`).toBeTruthy();
}

test('the rep sets the estimate on their lead page; it is stored as integer cents', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, repEmail, PASSWORD, '/sales');
  await gotoSettled(page, `/sales/leads/${ids.openRelationId}`);

  const panel = page.getByTestId('deal-value-panel');
  await expect(panel).toContainText('Estimated monthly value');
  await expect(page.getByTestId('deal-value-current')).toHaveText('No estimate yet');

  await page.getByTestId('deal-value-input').fill('abc');
  await page.getByTestId('deal-value-save').click();
  await expect(page.getByTestId('deal-value-error')).toBeVisible();

  await page.getByTestId('deal-value-input').fill('1.234,50');
  await page.getByTestId('deal-value-save').click();
  await expect(page.getByTestId('deal-value-current')).toHaveText('€1,234.50');

  const row = await prisma.relationValue.findUnique({ where: { relationId: ids.openRelationId } });
  expect(row).toMatchObject({ valueMinor: 123450, currency: 'EUR', source: 'MANUAL', orgId });
  expect(Number.isInteger(row!.valueMinor)).toBe(true);

  // A float from a hand-written client is refused, never rounded.
  const float = await page.request.put(`/api/mentorship/${ids.openRelationId}/value`, { data: { valueMinor: 49.9 } });
  expect(float.status()).toBe(400);
  expect((await float.json()).code).toBe('invalid_amount');
  expect((await prisma.relationValue.findUnique({ where: { relationId: ids.openRelationId } }))!.valueMinor).toBe(123450);
});

test('the lead on the record never reads the estimate back (#1801)', async ({ request }) => {
  await apiAs(request, leadEmail, MARKETING_HOST);
  const relation = await request.get(`/api/mentorship/${ids.openRelationId}`, onMarketing);
  expect(relation.status()).toBe(200);
  const body = await relation.text();
  expect(body).not.toContain('123450');
  expect(body).not.toContain('valueMinor');
  const list = await request.get('/api/mentorship', onMarketing);
  expect(await list.text()).not.toContain('valueMinor');

  expect((await request.get(`/api/mentorship/${ids.openRelationId}/value`, onMarketing)).status()).toBe(403);
  expect((await request.put(`/api/mentorship/${ids.openRelationId}/value`, { ...onMarketing, data: { valueMinor: 1 } })).status()).toBe(403);
});

test('the MARKETING admin sees the monthly estimated series and the editor on the record page', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, adminEmail, PASSWORD, '/admin');

  await gotoSettled(page, '/admin/analytics');
  const card = page.getByTestId('deal-value-card');
  await expect(card).toContainText('Estimated value of won deals');
  await expect(card).toContainText('Estimated MRR');
  // Won in month −2: one new win worth €120.00, and still held since.
  await expect(page.getByTestId(`deal-value-${monthKey(2)}-won`)).toContainText('1');
  await expect(page.getByTestId(`deal-value-${monthKey(2)}-won`)).toContainText('€120.00');
  await expect(page.getByTestId(`deal-value-${monthKey(3)}-active`)).toHaveText('0');
  // Month −1 adds the chain-to-be won then (€70.00): €190.00 held at its end.
  await expect(page.getByTestId(`deal-value-${monthKey(1)}-won`)).toContainText('€70.00');
  await expect(page.getByTestId(`deal-value-${monthKey(1)}-mrr`)).toContainText('€190.00');

  const api = await page.request.get('/api/admin/analytics/deal-value');
  const series = await api.json();
  expect(series).toMatchObject({ enabled: true, ok: true, currency: 'EUR' });

  // The shared admin record page carries the editor for a MARKETING record.
  await gotoSettled(page, `/admin/candidates/${ids.leadId}`);
  await expect(page.getByTestId('deal-value-current')).toHaveText('€1,234.50');
});

test('a transfer copies the estimate; clearing it on the successor sticks in the series', async ({ request }) => {
  await apiAs(request, adminEmail, MARKETING_HOST);
  const seriesRow = async (m: string) => {
    const res = await request.get('/api/admin/analytics/deal-value', onMarketing);
    const body = await res.json();
    expect(body).toMatchObject({ enabled: true, ok: true });
    return body.months.find((row: { month: string }) => row.month === m);
  };
  // Before: two won accounts held this month, €120.00 + €70.00.
  expect((await seriesRow(monthKey(0))).activeAtEnd).toEqual({ count: 2, valueMinor: 19000, unvalued: 0 });

  const res = await request.post(`/api/mentorship/${ids.handedRelationId}/transfer`, {
    ...onMarketing,
    data: { toMentorId: ids.rep2Id, reasonCode: 'mentor_unavailable' },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  expect((await res.json()).mode).toBe('transferred');

  const successor = await prisma.mentorshipRelation.findFirst({
    where: { previousRelationId: ids.handedRelationId },
    include: { value: true },
  });
  expect(successor!.value).toMatchObject({ valueMinor: 7000, currency: 'EUR', source: 'MANUAL', orgId });
  // The predecessor keeps its own row (history), and the chain is ONE account.
  expect(await prisma.relationValue.count({ where: { relationId: ids.handedRelationId } })).toBe(1);
  expect((await seriesRow(monthKey(0))).activeAtEnd).toEqual({ count: 2, valueMinor: 19000, unvalued: 0 });

  // The owner clears the live record's estimate: the old copy must not come back.
  const cleared = await request.put(`/api/mentorship/${successor!.id}/value`, { ...onMarketing, data: { valueMinor: null } });
  expect(cleared.ok()).toBeTruthy();
  expect(await prisma.relationValue.count({ where: { relationId: successor!.id } })).toBe(0);
  expect((await seriesRow(monthKey(0))).activeAtEnd).toEqual({ count: 2, valueMinor: 12000, unvalued: 1 });
});

test('a PUT without a currency keeps the stored one', async ({ request }) => {
  await prisma.relationValue.update({ where: { relationId: ids.openRelationId }, data: { currency: 'CHF' } });
  await apiAs(request, repEmail, MARKETING_HOST);
  const res = await request.put(`/api/mentorship/${ids.openRelationId}/value`, { ...onMarketing, data: { valueMinor: 5000 } });
  expect(res.ok()).toBeTruthy();
  expect(await prisma.relationValue.findUnique({ where: { relationId: ids.openRelationId } })).toMatchObject({
    valueMinor: 5000,
    currency: 'CHF',
  });
});

test('the account import writes the estimate: gap-fill, and a MANUAL value is left alone', async () => {
  const header =
    'name,legal_name,country,city,vat_id,website,industry,locale,stage,source,monthly_transactions,mrr,owner_email,channels,contact_name,contact_email,contact_phone';
  const contact = `dv-import-${STAMP}@example.com`;
  const text = [header, `DV Import ${STAMP},,DE,Kiel,,,Retail,de,${ids.qualifiedStage},Messe,1,"49,90",,,Ida,${contact},`].join('\n');

  const first = await runMarketingAccountImport({ text, ownerEmail: repEmail, apply: true });
  expect(first.report.counts.ERROR, JSON.stringify(first.report.rows)).toBe(0);
  const company = await prisma.company.findFirst({ where: { orgId, name: `DV Import ${STAMP}` } });
  const relation = await prisma.mentorshipRelation.findFirst({
    where: { companyId: company!.id, status: 'ACTIVE' },
    include: { value: true },
  });
  expect(relation!.value).toMatchObject({ valueMinor: 4990, currency: 'EUR', source: 'IMPORT', orgId });

  // A rep corrects it in the app; re-running the same file leaves it alone …
  await prisma.relationValue.update({ where: { relationId: relation!.id }, data: { valueMinor: 9900, source: 'MANUAL' } });
  await runMarketingAccountImport({ text, ownerEmail: repEmail, apply: true });
  expect(await prisma.relationValue.findUnique({ where: { relationId: relation!.id } })).toMatchObject({
    valueMinor: 9900,
    source: 'MANUAL',
  });
  // … and only an authoritative run overwrites it, in place (upsert, one row).
  await runMarketingAccountImport({ text, ownerEmail: repEmail, apply: true, authoritative: true });
  expect(await prisma.relationValue.findUnique({ where: { relationId: relation!.id } })).toMatchObject({
    valueMinor: 4990,
    currency: 'EUR',
    source: 'IMPORT',
  });
});

test('an INTERNSHIP tenant has no deal values: no route, no card', async ({ page }) => {
  test.slow();
  await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');
  const series = await page.request.get('/api/admin/analytics/deal-value');
  expect(await series.json()).toEqual({ enabled: false });
  const put = await page.request.put(`/api/mentorship/${ids.internRelationId}/value`, { data: { valueMinor: 100 } });
  expect(put.status()).toBe(404);
  expect((await put.json()).code).toBe('deal_value_unavailable');
  expect(await prisma.relationValue.count({ where: { relationId: ids.internRelationId } })).toBe(0);

  await gotoSettled(page, '/admin/analytics');
  await expect(page.getByTestId('funnel-kpi-card').or(page.getByTestId('pipeline-funnel-card')).first()).toBeVisible();
  await expect(page.getByTestId('deal-value-card')).toHaveCount(0);
});
