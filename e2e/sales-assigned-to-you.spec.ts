import crypto from 'crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInViaApi, signInAndSettle, gotoSettled } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// "Assigned to you" (#3874, src/lib/assignedToYou.ts): a record that came to the
// rep from someone else (here an admin's hand-off) is listed first on /sales and
// as a strip on /sales/board, until the rep opens it. A record that is the rep's
// own doing, or older than the columns, is never listed; nobody sees another
// rep's card. SYNTHETIC ONLY.

test.describe.configure({ mode: 'serial' });

const PW = 'AssignedToYou123!';
const STAMP = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const H = asHost(MARKETING_HOST);
const emails: string[] = [];
const ids: Record<string, string> = {};
const mail: Record<string, string> = {};
let orgId = '';

async function person(label: string, role: 'ADMIN' | 'MENTOR' | 'MENTEE') {
  const email = uniqueEmail(`a2y-${label}-${STAMP}`);
  emails.push(email);
  const user = await seedUser(email, PW, role, `A2Y ${label} ${STAMP}`, orgId);
  ids[label] = user.id;
  mail[label] = email;
  return user.id;
}

async function lead(label: string, ownerId: string, extra: Record<string, unknown> = {}) {
  const menteeId = await person(`lead-${label}`, 'MENTEE');
  const rel = await prisma.mentorshipRelation.create({ data: { orgId, mentorId: ownerId, menteeId, pipelineStatus: 'LEAD_QUALIFIED', ...extra } });
  ids[`rel-${label}`] = rel.id;
  return rel.id;
}

let admin: APIRequestContext;

test.beforeAll(async ({ playwright, baseURL }) => {
  orgId = (await prisma.organization.create({ data: { name: `Acme Sales A2Y ${STAMP}`, slug: `a2y-${STAMP}`, vertical: 'MARKETING' } })).id;
  const preset = defaultTemplateForVertical('MARKETING');
  if (!preset) throw new Error('MARKETING must provision a stage preset');
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(preset, 'en').stages.map((st) => ({
      orgId,
      key: st.key,
      label: st.label,
      order: st.order,
      isTerminal: st.isTerminal,
      isOffPath: st.isOffPath,
      color: st.color,
    })),
  });
  await person('admin', 'ADMIN');
  await person('rep1', 'MENTOR');
  await person('rep2', 'MENTOR');
  await lead('handed', ids.rep1);
  // Older than the columns: never "new".
  await lead('old', ids.rep2);
  // The rep's own doing (a claim, a lead they typed in): not news either.
  await lead('own', ids.rep2, { assignedAt: new Date(), assignedById: ids.rep2 });

  admin = await playwright.request.newContext({ baseURL, extraHTTPHeaders: H });
  const res = await signInViaApi(admin, mail.admin, PW, { host: MARKETING_HOST, headers: freshIp('a2y-admin') });
  expect(res.error).toBeNull();
  const handed = await admin.post(`/api/sales/leads/${ids['rel-handed']}/handoff`, { data: { toUserId: ids.rep2, action: 'call', note: `Ring them ${STAMP}` } });
  expect(handed.status()).toBe(200);
  ids.handedNow = (await handed.json()).relationId;
});

test.afterAll(async () => {
  await admin?.dispose();
  const userIds = Object.entries(ids).filter(([k]) => !k.startsWith('rel-') && k !== 'handedNow').map(([, v]) => v);
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await prisma.notificationDelivery.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await prisma.activityLog.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.mentorshipRelation.updateMany({ where: { orgId }, data: { previousRelationId: null } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
  for (const e of emails) await cleanupByEmail(e);
  await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('the hand-off stamps who and when on the record the rep now owns', async () => {
  const row = await prisma.mentorshipRelation.findUniqueOrThrow({
    where: { id: ids.handedNow },
    select: { mentorId: true, assignedAt: true, assignedById: true, assignmentSeenAt: true },
  });
  expect(row).toMatchObject({ mentorId: ids.rep2, assignedById: ids.admin, assignmentSeenAt: null });
  expect(row.assignedAt).not.toBeNull();
});

test('the rep sees it first on /sales and on the board; opening it clears both', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(H);
  await signInAndSettle(page, mail.rep2, PW, '/sales');
  await gotoSettled(page, '/sales');

  const card = page.getByTestId('assigned-to-you');
  await expect(card).toBeVisible();
  const row = card.getByTestId(`assigned-to-you-${ids.handedNow}`);
  await expect(row).toContainText(`A2Y lead-handed ${STAMP}`);
  await expect(row).toContainText(`from A2Y admin ${STAMP}`);
  await expect(row).toContainText(`Ring them ${STAMP}`);
  // Only what came from someone else: not the old record, not the rep's own.
  await expect(card.locator('li')).toHaveCount(1);
  // First on the page: above "Today".
  const [cardBox, todayBox] = await Promise.all([card.boundingBox(), page.getByTestId('sales-today').boundingBox()]);
  expect(cardBox!.y).toBeLessThan(todayBox!.y);

  await gotoSettled(page, '/sales/board');
  const strip = page.getByTestId('assigned-to-you-strip');
  await expect(strip).toContainText(`A2Y lead-handed ${STAMP}`);

  await strip.getByTestId(`assigned-to-you-strip-${ids.handedNow}`).click();
  await page.waitForURL((u) => u.pathname === `/sales/leads/${ids.handedNow}`);
  await expect.poll(async () => (await prisma.mentorshipRelation.findUnique({ where: { id: ids.handedNow }, select: { assignmentSeenAt: true } }))?.assignmentSeenAt).not.toBeNull();

  await gotoSettled(page, '/sales');
  await expect(page.getByTestId('sales-dashboard')).toBeVisible();
  await expect(page.getByTestId('assigned-to-you')).toHaveCount(0);
  await gotoSettled(page, '/sales/board');
  await expect(page.getByTestId('assigned-to-you-strip')).toHaveCount(0);
});

test('nobody else sees the card: the previous owner has none', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(H);
  await signInAndSettle(page, mail.rep1, PW, '/sales');
  await gotoSettled(page, '/sales');
  await expect(page.getByTestId('sales-dashboard')).toBeVisible();
  await expect(page.getByTestId('assigned-to-you')).toHaveCount(0);
});
