import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInAndSettle, gotoSettled } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';
import { PLACEHOLDER_EMAIL_DOMAIN } from '../src/lib/menteeAccount';

// The affiliate behind a lead (#3647). A lead that came in through a partner's
// link carries the Source `affiliate:<code>`; the lead page and the board card
// say "Affiliate: <partner>", resolved by (org, code) so a code never names
// another org's partner. The partner's own portal shows how many leads it
// brought and where they are — counts only: no lead name, contact or account,
// and never another partner's leads.

test.describe.configure({ mode: 'serial' });

const PW = 'AffiliateBadge123!';
const STAMP = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const H = asHost(MARKETING_HOST);
const emails: string[] = [];
const orgIds: string[] = [];
const ids: Record<string, string> = {};
const LEAD_NAME = `Secret Lead ${STAMP}`;
let firstStage = { key: '', label: '' };
let secondStage = { key: '', label: '' };

async function marketingOrg(label: string) {
  const org = await prisma.organization.create({
    data: { name: `Acme Sales Aff ${label} ${STAMP}`, slug: `aff-badge-${label}-${STAMP}`, vertical: 'MARKETING' },
  });
  orgIds.push(org.id);
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
  const onPath = stages.filter((s) => !s.isOffPath && !s.isTerminal).sort((a, b) => a.order - b.order);
  firstStage = { key: onPath[0].key, label: onPath[0].label };
  secondStage = { key: onPath[1].key, label: onPath[1].label };
  return org.id;
}

/** A lead of `orgId` whose Source is `sourceName`, on `ownerId`'s book at `stage`. */
async function lead(orgId: string, ownerId: string, label: string, sourceName: string, stage: string, fullName = `Lead ${label} ${STAMP}`) {
  const source = await prisma.source.create({ data: { orgId, name: sourceName } });
  const company = await prisma.company.create({ data: { orgId, name: `Acme ${label} ${STAMP}` } });
  const email = `aff-${label}-${STAMP}@${PLACEHOLDER_EMAIL_DOMAIN}`.toLowerCase();
  emails.push(email);
  const person = await seedUser(email, 'not-a-login-123', 'MENTEE', fullName, orgId);
  await prisma.user.update({ where: { id: person.id }, data: { companyId: company.id, sourceId: source.id } });
  const relation = await prisma.mentorshipRelation.create({
    data: { orgId, mentorId: ownerId, menteeId: person.id, companyId: company.id, pipelineStatus: stage },
  });
  return relation.id;
}

test.beforeAll(async () => {
  const orgA = await marketingOrg('a');
  const orgB = await marketingOrg('b');
  ids.orgA = orgA;
  const adminEmail = uniqueEmail(`aff-badge-admin-${STAMP}`).toLowerCase();
  const repEmail = uniqueEmail(`aff-badge-rep-${STAMP}`).toLowerCase();
  const partnerEmail = uniqueEmail(`aff-badge-partner-${STAMP}`).toLowerCase();
  const otherPartnerEmail = uniqueEmail(`aff-badge-partner2-${STAMP}`).toLowerCase();
  const repBEmail = uniqueEmail(`aff-badge-repb-${STAMP}`).toLowerCase();
  emails.push(adminEmail, repEmail, partnerEmail, otherPartnerEmail, repBEmail);
  ids.admin = (await seedUser(adminEmail, PW, 'ADMIN', `Aff Admin ${STAMP}`, orgA)).id;
  ids.rep = (await seedUser(repEmail, PW, 'MENTOR', `Aff Rep ${STAMP}`, orgA)).id;
  ids.repB = (await seedUser(repBEmail, PW, 'MENTOR', `Aff Rep B ${STAMP}`, orgB)).id;
  const partnerUser = await seedUser(partnerEmail, PW, 'AFFILIATE', `Aff Partner ${STAMP}`, orgA);
  const otherPartnerUser = await seedUser(otherPartnerEmail, PW, 'AFFILIATE', `Aff Partner Two ${STAMP}`, orgA);
  const code = `acme-${STAMP}`.slice(0, 60);
  await prisma.affiliatePartner.create({ data: { orgId: orgA, userId: partnerUser.id, code, displayName: `Partner One ${STAMP}` } });
  await prisma.affiliatePartner.create({ data: { orgId: orgA, userId: otherPartnerUser.id, code: `other-${STAMP}`.slice(0, 60), displayName: `Partner Two ${STAMP}` } });
  // Same code in another org, another partner: a code must never cross orgs.
  await prisma.affiliatePartner.create({ data: { orgId: orgB, code, displayName: `Foreign Partner ${STAMP}` } });

  // Partner One brought two leads (two stages); Partner Two one; one lead came in by UTM.
  ids.aff1 = await lead(orgA, ids.rep, 'aff1', `affiliate:${code}`, firstStage.key, LEAD_NAME);
  ids.aff2 = await lead(orgA, ids.rep, 'aff2', `affiliate:${code}`, secondStage.key);
  ids.other = await lead(orgA, ids.rep, 'other', `affiliate:other-${STAMP}`.slice(0, 70), firstStage.key);
  ids.utm = await lead(orgA, ids.rep, 'utm', 'utm:newsletter/email/-', firstStage.key);
  // The foreign org's lead with the same code is that org's partner's — never counted here.
  ids.foreign = await lead(orgB, ids.repB, 'foreign', `affiliate:${code}`, firstStage.key);
  ids.partnerEmail = partnerEmail;
  ids.repEmail = repEmail;
  ids.adminEmail = adminEmail;
});

test.afterAll(async () => {
  await prisma.mentorshipRelation.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  for (const e of emails) await cleanupByEmail(e);
  await prisma.affiliatePartner.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.source.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.company.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.pipelineStage.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => {});
  await prisma.$disconnect();
});

test('an affiliate-sourced lead shows "Affiliate: <partner>" on its page and its board card; other leads show none', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(H);
  await signInAndSettle(page, ids.repEmail, PW, '/sales');

  await gotoSettled(page, `/sales/leads/${ids.aff1}`);
  await expect(page.getByTestId('affiliate-source-badge')).toHaveText(`Affiliate: Partner One ${STAMP}`);
  await gotoSettled(page, `/sales/leads/${ids.utm}`);
  await expect(page.getByTestId('affiliate-source-badge')).toHaveCount(0);

  // The board list carries the name for staff readers.
  const list = (await (await page.request.get('/api/mentorship?view=board')).json()) as {
    relations?: { id: string; affiliatePartner?: string | null }[];
    columns?: unknown;
  };
  const rows = list.relations ?? [];
  const byId = new Map(rows.map((r) => [r.id, r.affiliatePartner ?? null]));
  expect(byId.get(ids.aff1)).toBe(`Partner One ${STAMP}`);
  expect(byId.get(ids.other)).toBe(`Partner Two ${STAMP}`);
  expect(byId.get(ids.utm)).toBeNull();

  await gotoSettled(page, '/sales/board');
  const card = page.getByTestId('board-card').filter({ hasText: LEAD_NAME });
  await expect(card.getByTestId('affiliate-source-badge')).toHaveText(`Affiliate: Partner One ${STAMP}`);
});

test('the partner sees how many leads it brought and their stages — no lead name, never another partner\'s or another org\'s', { tag: '@smoke' }, async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(H);
  await signInAndSettle(page, ids.partnerEmail, PW, '/affiliate');
  await gotoSettled(page, '/affiliate');
  const card = page.getByTestId('affiliate-leads');
  // Two of its own leads; Partner Two's lead, the UTM lead and the other org's same-code lead are not counted.
  await expect(card.getByTestId('affiliate-leads-count')).toHaveText('2 lead(s) came in through your link.');
  await expect(card.getByTestId(`affiliate-leads-stage-${firstStage.key}`)).toContainText('1');
  await expect(card.getByTestId(`affiliate-leads-stage-${secondStage.key}`)).toContainText('1');
  await expect(card.getByTestId(`affiliate-leads-stage-${firstStage.key}`)).toContainText(firstStage.label);
  // Counts only: the lead's name appears nowhere on the portal.
  await expect(page.getByText(LEAD_NAME)).toHaveCount(0);
  expect(await page.content()).not.toContain(LEAD_NAME);
});
