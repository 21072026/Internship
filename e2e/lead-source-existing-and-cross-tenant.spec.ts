import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// Two edges of lead-source attribution (#2570) the first cut missed (review):
//
//   1. AN EXISTING LEAD is bound too. The import's typed `source` used to be
//      read from the diff's `leadChanges`, which omits a `referralSource` the
//      lead already carries — so re-importing the marketing book (leads that
//      say "Messe …" in free text and predate attribution) bound none of them.
//      Driven through the real CLI, `--apply`, twice. A lead that already has
//      a referrer keeps it, and no Source row is created for it.
//
//   2. A SOURCE OUTSIDE THE LEAD'S TENANT. Before #2570 sources were created
//      without an org (the backfill gave them to the default org) and the
//      pickers were unscoped, so a MARKETING lead can point at a default-org
//      source. The default org's /admin/sources must not count that lead, and
//      the MARKETING report must count it as unsourced instead of losing it.

const execFileAsync = promisify(execFile);
const PW = 'LeadSrcExisting123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function marketingOrg(stamp: string) {
  const org = await prisma.organization.create({
    data: { name: `LeadSrc MKT ${stamp}`, slug: `leadsrc-mkt-${stamp}`, vertical: 'MARKETING' },
  });
  const preset = defaultTemplateForVertical('MARKETING');
  if (!preset) throw new Error('MARKETING must provision a stage preset');
  const stages = templateStagePayload(preset, 'en').stages;
  await prisma.pipelineStage.createMany({
    data: stages.map((st) => ({
      orgId: org.id,
      key: st.key,
      label: st.label,
      order: st.order,
      isTerminal: st.isTerminal,
      isOffPath: st.isOffPath,
      color: st.color,
    })),
  });
  const first = [...stages].filter((s) => !s.isOffPath).sort((a, b) => a.order - b.order)[0];
  return { org, firstStage: first.key };
}

async function cleanupOrg(orgId: string, emails: string[]) {
  const companies = await prisma.company.findMany({ where: { orgId }, select: { id: true } });
  const companyIds = companies.map((c) => c.id);
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { orgId, companyId: { in: companyIds } } }).catch(() => {});
  for (const email of emails) await cleanupByEmail(email);
  await prisma.company.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.activityLog.deleteMany({ where: { targetId: { in: [...companyIds, orgId] } } }).catch(() => {});
  await prisma.source.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.setting.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
}

test('re-importing an existing lead binds it to the typed source; a lead with a referrer keeps it', async () => {
  test.setTimeout(120_000);
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const { org, firstStage } = await marketingOrg(stamp);
  const ownerEmail = uniqueEmail('leadsrc-owner');
  const owner = await seedUser(ownerEmail, PW, 'ADMIN', 'LeadSrc Owner');
  await prisma.user.update({ where: { id: owner.id }, data: { orgId: org.id } });
  const dir = mkdtempSync(join(tmpdir(), 'leadsrc-'));
  const contact = uniqueEmail('leadsrc-contact');
  const header = 'name,country,stage,source,contact_name,contact_email';
  const importFile = async (source: string) => {
    const file = join(dir, `accounts-${source.length}.csv`);
    writeFileSync(file, `${header}\nLeadSrc Co ${stamp},DE,${firstStage},${source},Lena Sommer,${contact}\n`);
    await execFileAsync(
      process.execPath,
      ['--experimental-strip-types', 'scripts/import-marketing-accounts.mjs', `--file=${file}`, `--owner=${ownerEmail}`, '--apply'],
      { cwd: process.cwd(), env: process.env },
    );
  };
  const theLead = () =>
    prisma.user.findFirstOrThrow({
      where: { orgId: org.id, role: 'MENTEE', company: { name: `LeadSrc Co ${stamp}` } },
      select: { id: true, sourceId: true, referralSource: true },
    });
  const fair = `Messe Berlin ${stamp}`;
  try {
    await importFile(fair);
    const created = await theLead();
    const source = await prisma.source.findFirstOrThrow({ where: { orgId: org.id, name: fair } });
    expect(created.sourceId).toBe(source.id);

    // The state a lead that predates attribution is in: the free text says
    // "Messe Berlin", no Source is bound. Same file again → bound.
    await prisma.user.update({ where: { id: created.id }, data: { sourceId: null } });
    await importFile(fair);
    const rebound = await theLead();
    expect(rebound.referralSource).toBe(fair);
    expect(rebound.sourceId).toBe(source.id);
    expect(await prisma.source.count({ where: { orgId: org.id, name: fair } })).toBe(1);

    // First touch: a lead referred by a person keeps that, and the file's new
    // source name creates no Source row nobody would use.
    await prisma.user.update({ where: { id: created.id }, data: { sourceId: null, referredById: owner.id } });
    const other = `Partner ${stamp}`;
    await importFile(other);
    expect((await theLead()).sourceId).toBeNull();
    expect(await prisma.source.count({ where: { name: other } })).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await prisma.user.updateMany({ where: { orgId: org.id }, data: { referredById: null } }).catch(() => {});
    await cleanupOrg(org.id, [ownerEmail]);
  }
});

test("a lead pointing at another tenant's source: not counted there, unsourced in its own report", async ({ browser }) => {
  test.setTimeout(120_000);
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const { org } = await marketingOrg(`x-${stamp}`);
  const defaultAdminEmail = uniqueEmail('leadsrc-def-admin');
  const mktAdminEmail = uniqueEmail('leadsrc-mkt-admin');
  const defaultLeadEmail = uniqueEmail('leadsrc-def-lead');
  const mktLeadEmail = uniqueEmail('leadsrc-mkt-lead');
  await seedUser(defaultAdminEmail, PW, 'ADMIN', 'Default Admin');
  const mktAdmin = await seedUser(mktAdminEmail, PW, 'ADMIN', 'Marketing Admin');
  const defaultLead = await seedUser(defaultLeadEmail, 'x', 'MENTEE', 'Default Lead');
  const mktLead = await seedUser(mktLeadEmail, 'x', 'MENTEE', 'Marketing Lead');
  // A legacy source: no org, i.e. the default org's (the backfill's rule).
  const legacy = await prisma.source.create({ data: { name: `Legacy fair ${stamp}` } });
  await prisma.user.update({ where: { id: defaultLead.id }, data: { sourceId: legacy.id } });
  await prisma.user.update({ where: { id: mktAdmin.id }, data: { orgId: org.id } });
  await prisma.user.update({ where: { id: mktLead.id }, data: { orgId: org.id, sourceId: legacy.id } });

  const defCtx = await browser.newContext();
  const mktCtx = await browser.newContext();
  const defPage = await defCtx.newPage();
  const mktPage = await mktCtx.newPage();
  try {
    await signInAndSettle(defPage, defaultAdminEmail, PW, '/admin');
    await signInAndSettle(mktPage, mktAdminEmail, PW, '/admin');

    const listed = ((await (await defPage.request.get('/api/admin/sources')).json()) as {
      sources: { id: string; mentees: number }[];
    }).sources.find((s) => s.id === legacy.id);
    expect(listed, 'the legacy source is the default org’s').toBeTruthy();
    expect(listed!.mentees, 'only the default org’s own lead is counted').toBe(1);

    expect((await mktPage.request.put('/api/admin/settings', { data: { premiumAnalytics: 'true' } })).ok()).toBeTruthy();
    const report = (await (await mktPage.request.get('/api/admin/analytics/sources')).json()) as {
      sources: { id: string }[];
      unsourced: number;
    };
    expect(report.sources.map((s) => s.id)).not.toContain(legacy.id);
    // The tenant's one lead points outside it: counted as unsourced, not lost.
    expect(report.unsourced).toBe(1);
  } finally {
    // Through the route, like the neighbours: with isolation off it writes the
    // GLOBAL row, which a direct delete of the org's settings would not undo.
    await mktPage.request.put('/api/admin/settings', { data: { premiumAnalytics: 'false' } }).catch(() => {});
    await defCtx.close();
    await mktCtx.close();
    for (const email of [defaultLeadEmail, mktLeadEmail, defaultAdminEmail, mktAdminEmail]) await cleanupByEmail(email);
    await prisma.source.delete({ where: { id: legacy.id } }).catch(() => {});
    await cleanupOrg(org.id, []);
  }
});
