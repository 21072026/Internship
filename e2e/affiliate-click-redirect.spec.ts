import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInAndSettle } from './helpers/auth';
import { freshIp as freshIpHeaders } from './helpers/rateLimit';

/**
 * The partner link's click redirect and daily counter (docs/affiliate-module.md
 * § Link clicks, #3541).
 *
 * What this pins:
 *   1. `/r/<code>` answers 302 to the referral URL with `ref=<code>`, counts one
 *      click, and a second click of the same visitor counts a click but not a
 *      new unique one;
 *   2. an unknown code, a suspended partner, another org's code, a bot and a
 *      visitor over the limit are redirected all the same and counted never;
 *   3. without a referral URL the visitor lands on the home page, not an error;
 *   4. the portal hands out the /r/ link with the direct one kept as the old link.
 * @smoke on the counting boundaries: a public, sessionless write.
 *
 * Serial and host-borrowing, like e2e/affiliate-public-page.spec.ts: `publicHost`
 * is unique, so whoever held MARKETING_HOST before gets it back in afterAll.
 * The click is counted after the response, so counts are polled. Each test
 * clicks from its own synthetic address (`freshIp()`): the limit and the
 * "unique" check are per visitor. SYNTHETIC ONLY.
 */

test.describe.configure({ mode: 'serial' });

const PW = 'AffClick123!';
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const REFERRAL_URL = 'https://app.acme.example/auth/registration';
const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const codes = { active: `acme-${stamp}`, suspended: `paused-${stamp}`, other: `other-${stamp}`, limited: `busy-${stamp}` };
const ids = { active: '', suspended: '', other: '', limited: '' };
let orgId = '';
let otherOrgId = '';
let previousHolderId: string | null = null;
let partnerEmail = '';
let api: APIRequestContext;
/** A new synthetic visitor: the headers a one-hop proxy would send for a fresh address. */
const freshIp = () => freshIpHeaders('affiliate-click');

function click(code: string, visitor: Record<string, string>, userAgent = BROWSER) {
  return api.get(`/r/${encodeURIComponent(code)}`, {
    maxRedirects: 0,
    headers: { ...asHost(MARKETING_HOST), ...visitor, 'user-agent': userAgent },
  });
}

async function counts(partnerId: string) {
  const rows = await prisma.affiliateClickDaily.findMany({ where: { partnerId } });
  return {
    rows: rows.length,
    clicks: rows.reduce((n, r) => n + r.clicks, 0),
    uniqueClicks: rows.reduce((n, r) => n + r.uniqueClicks, 0),
  };
}

/** Wait until a counted click has landed: the counter runs after the response. */
async function expectCounts(partnerId: string, expected: { clicks: number; uniqueClicks: number }) {
  await expect.poll(() => counts(partnerId).then(({ clicks, uniqueClicks }) => ({ clicks, uniqueClicks })), { timeout: 10_000 }).toEqual(expected);
}

test.beforeAll(async ({ playwright, baseURL }) => {
  api = await playwright.request.newContext({ baseURL });
  const holder = await prisma.organization.findUnique({ where: { publicHost: MARKETING_HOST }, select: { id: true, slug: true } });
  if (holder && !holder.slug.startsWith('aff-click-')) previousHolderId = holder.id;
  if (holder) await prisma.organization.update({ where: { id: holder.id }, data: { publicHost: null } });
  orgId = (
    await prisma.organization.create({
      data: { name: `Acme Sales ${stamp}`, slug: `aff-click-${stamp}`, vertical: 'MARKETING', publicHost: MARKETING_HOST },
    })
  ).id;
  otherOrgId = (await prisma.organization.create({ data: { name: `Globex ${stamp}`, slug: `aff-click-other-${stamp}`, vertical: 'MARKETING' } })).id;
  await prisma.affiliateProgramSettings.create({ data: { orgId, referralUrl: REFERRAL_URL } });
  await prisma.affiliateProgramSettings.create({ data: { orgId: otherOrgId, referralUrl: 'https://app.globex.example/' } });

  partnerEmail = uniqueEmail('aff-click-partner');
  const partnerUser = await seedUser(partnerEmail, PW, 'AFFILIATE', 'Click Partner', { orgId });
  ids.active = (await prisma.affiliatePartner.create({ data: { orgId, userId: partnerUser.id, code: codes.active, displayName: 'Active' } })).id;
  ids.suspended = (await prisma.affiliatePartner.create({ data: { orgId, code: codes.suspended, displayName: 'Paused', status: 'SUSPENDED' } })).id;
  ids.limited = (await prisma.affiliatePartner.create({ data: { orgId, code: codes.limited, displayName: 'Busy' } })).id;
  ids.other = (await prisma.affiliatePartner.create({ data: { orgId: otherOrgId, code: codes.other, displayName: 'Other org' } })).id;
});

test.afterAll(async () => {
  await api?.dispose();
  for (const id of [orgId, otherOrgId].filter(Boolean)) {
    await prisma.affiliateClickDaily.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliatePartner.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliateProgramSettings.deleteMany({ where: { orgId: id } }).catch(() => {});
  }
  if (partnerEmail) await cleanupByEmail(partnerEmail);
  for (const id of [orgId, otherOrgId].filter(Boolean)) await prisma.organization.deleteMany({ where: { id } }).catch(() => {});
  if (previousHolderId) {
    await prisma.organization
      .update({ where: { id: previousHolderId }, data: { publicHost: MARKETING_HOST } })
      .catch((e) => console.error(`affiliate-click-redirect: could not restore publicHost ${MARKETING_HOST}:`, e));
  }
  await prisma.$disconnect();
});

test('a click redirects to the referral URL and counts; a repeat counts a click, not a visitor', { tag: '@smoke' }, async () => {
  const ip = freshIp();
  const first = await click(codes.active, ip);
  expect(first.status()).toBe(302);
  expect(first.headers()['location']).toBe(`${REFERRAL_URL}?ref=${codes.active}`);
  await expectCounts(ids.active, { clicks: 1, uniqueClicks: 1 });

  const again = await click(codes.active, ip);
  expect(again.status()).toBe(302);
  await expectCounts(ids.active, { clicks: 2, uniqueClicks: 1 });
  // One row per partner and day — counters only.
  expect((await counts(ids.active)).rows).toBe(1);

  // Another visitor is a new unique click.
  await click(codes.active, freshIp());
  await expectCounts(ids.active, { clicks: 3, uniqueClicks: 2 });
});

test('unknown, suspended and other-org codes and bots are redirected but never counted', { tag: '@smoke' }, async () => {
  const ip = freshIp();
  const unknown = `nobody-${stamp}`;
  const res = await click(unknown, ip);
  expect(res.status()).toBe(302);
  // The Location does not reveal whether the code belongs to a partner.
  expect(res.headers()['location']).toBe(`${REFERRAL_URL}?ref=${unknown}`);
  // A malformed code never reaches the target.
  const odd = await click('x?next=https://evil.example', ip);
  expect(odd.status()).toBe(302);
  expect(odd.headers()['location']).toBe(REFERRAL_URL);

  const paused = await click(codes.suspended, ip);
  expect(paused.status()).toBe(302);
  // Another org's partner, on a host that org does not own: sent on with this
  // programme's URL, and not counted for anyone.
  const other = await click(codes.other, ip);
  expect(other.status()).toBe(302);
  expect(other.headers()['location']).toBe(`${REFERRAL_URL}?ref=${codes.other}`);
  const bot = await click(codes.active, freshIp(), 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)');
  expect(bot.status()).toBe(302);
  const before = await counts(ids.active);

  // A countable click after them, polled until it lands, so the ones before had their chance to be written.
  await click(codes.active, freshIp());
  await expectCounts(ids.active, { clicks: before.clicks + 1, uniqueClicks: before.uniqueClicks + 1 });
  expect(await counts(ids.suspended)).toEqual({ rows: 0, clicks: 0, uniqueClicks: 0 });
  expect(await counts(ids.other)).toEqual({ rows: 0, clicks: 0, uniqueClicks: 0 });
  expect(await prisma.affiliateClickDaily.count({ where: { orgId: otherOrgId } })).toBe(0);
  expect(await prisma.affiliateClickDaily.count({ where: { orgId } })).toBe(1);
});

test('over the per-visitor limit the visitor is still redirected, but not counted', { tag: '@smoke' }, async () => {
  const ip = freshIp();
  for (let i = 0; i < 30; i++) expect((await click(codes.limited, ip)).status()).toBe(302);
  await expectCounts(ids.limited, { clicks: 30, uniqueClicks: 1 });
  const over = await click(codes.limited, ip);
  expect(over.status()).toBe(302);
  expect(over.headers()['location']).toBe(`${REFERRAL_URL}?ref=${codes.limited}`);
  // Another visitor's click lands; the one over the limit never does.
  await click(codes.limited, freshIp());
  await expectCounts(ids.limited, { clicks: 31, uniqueClicks: 2 });
});

test('the portal hands out the /r/ link and keeps the direct one as the old link', async ({ page }) => {
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, partnerEmail, PW, '/affiliate');
  await expect(page.getByTestId('affiliate-referral-link')).toHaveText(new RegExp(`^https?://${MARKETING_HOST.replace(/\./g, '\\.')}(:\\d+)?/r/${codes.active}$`));
  await expect(page.getByTestId('affiliate-referral-link-direct')).toHaveText(`${REFERRAL_URL}?ref=${codes.active}`);
});

test('without a referral URL the visitor lands on the home page and nothing is counted', async () => {
  await prisma.affiliateProgramSettings.update({ where: { orgId }, data: { referralUrl: null } });
  const before = await counts(ids.active);
  const res = await click(codes.active, freshIp());
  expect(res.status()).toBe(302);
  expect(res.headers()['location']).toBe('/');
  // Nothing to wait for: no counter is scheduled without a target. A short grace
  // period still catches a regression that would schedule one.
  await new Promise((r) => setTimeout(r, 750));
  expect(await counts(ids.active)).toEqual(before);
});
