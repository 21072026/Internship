import { test, expect, type Locator } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// The relationship health badge (#1904): band chip, score, 30-day sparkline
// and the reasons on hover, on the mentor's mentee page, the admin candidate
// page and the admin mentorship list. Its data is GET /api/relation-health —
// an admin reads their tenant, a mentor only their own pairs, a mentee nothing.
// The chips are checked for contrast in light AND dark mode.

const PW = 'HealthBadge123!';
const DAY = 24 * 60 * 60 * 1000;

/** WCAG contrast of an element's text against its own background composited over the first opaque ancestor. */
async function chipContrast(chip: Locator): Promise<number> {
  return chip.evaluate((el) => {
    const parse = (c: string) => (c.match(/[\d.]+/g) ?? ['0', '0', '0', '0']).map(Number);
    const opaque = (node: Element | null): number[] => {
      for (let n = node; n; n = n.parentElement) {
        const [r, g, b, a = 1] = parse(getComputedStyle(n).backgroundColor);
        if (a >= 1 && getComputedStyle(n).backgroundColor !== 'rgba(0, 0, 0, 0)') return [r, g, b];
      }
      return document.documentElement.classList.contains('dark') ? [17, 24, 39] : [255, 255, 255];
    };
    const [br, bg, bb, ba = 1] = parse(getComputedStyle(el).backgroundColor);
    const under = opaque(el.parentElement);
    const back = [br, bg, bb].map((v, i) => v * ba + under[i] * (1 - ba));
    const [fr, fg, fb] = parse(getComputedStyle(el).color);
    const lum = (rgb: number[]) => {
      const [r, g, b] = rgb.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [l1, l2] = [lum([fr, fg, fb]), lum(back)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  });
}

test.describe('relationship health badge', () => {
  const stamp = `${Date.now()}`;
  const admin = uniqueEmail('hb-admin');
  const mentor = uniqueEmail('hb-mentor');
  const otherMentor = uniqueEmail('hb-other');
  const mentee = uniqueEmail('hb-mentee');
  let orgId = '';
  let menteeId = '';
  let relationId = '';

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `HB Org ${stamp}`, slug: `hb-${stamp}` } })).id;
    await seedUser(admin, PW, 'ADMIN', `HB Admin ${stamp}`, orgId);
    const mentorId = (await seedUser(mentor, PW, 'MENTOR', `HB Mentor ${stamp}`, orgId)).id;
    await seedUser(otherMentor, PW, 'MENTOR', `HB Other ${stamp}`, orgId);
    menteeId = (await seedUser(mentee, PW, 'MENTEE', `HB Mentee ${stamp}`, orgId)).id;
    // Started 60 days ago and never contacted: the "no recent contact" rule fires.
    const relation = await prisma.mentorshipRelation.create({
      data: { orgId, mentorId, menteeId, status: 'ACTIVE', startDate: new Date(Date.now() - 60 * DAY) },
    });
    relationId = relation.id;
    // Three nights of history for the sparkline.
    for (const [back, score, band] of [[3, 80, 'HEALTHY'], [2, 55, 'WATCH'], [1, 30, 'AT_RISK']] as const) {
      const d = new Date(Date.now() - back * DAY);
      await prisma.relationHealthSnapshot.create({
        data: { orgId, relationId, takenOn: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())), score, band, reasons: [], rulesVersion: 1 },
      });
    }
  });

  test.afterAll(async () => {
    await prisma.relationHealthSnapshot.deleteMany({ where: { relationId } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
    for (const email of [admin, mentor, otherMentor, mentee]) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  test('the mentor sees the badge on the mentee page, with reasons and a sparkline, legible in both themes', async ({ page, baseURL }) => {
    await signInAndSettle(page, mentor, PW, '/mentor');
    const api = await (await page.request.get(`/api/relation-health?ids=${relationId}`)).json();
    const h = api.health[relationId];
    expect(h.reasons).toContain('inactive');
    expect(h.series).toHaveLength(3);

    for (const theme of ['light', 'dark'] as const) {
      await page.context().addCookies([{ name: 'theme', value: theme, url: baseURL! }]);
      await page.goto(`/mentor/mentees/${relationId}`);
      const badge = page.getByTestId('relation-health');
      // The badge's read is one of ~20 the page fires at once; give it room.
      await expect(badge).toBeVisible({ timeout: 30_000 });
      await expect(badge).toHaveAttribute('data-band', h.band);
      await expect(badge.getByTestId('relation-health-score')).toHaveText(String(h.score));
      await expect(badge.getByTestId('relation-health-spark').locator('span')).toHaveCount(3);
      const contrast = await chipContrast(badge.getByTestId('relation-health-band'));
      expect(contrast, `${theme} band chip contrast`).toBeGreaterThanOrEqual(4.5);
    }
    await page.getByTestId('relation-health').locator('button').hover();
    await expect(page.getByTestId('relation-health-tooltip')).toBeVisible();
    await expect(page.getByTestId('relation-health-tooltip')).toContainText('No recent contact');
  });

  test('another mentor reads nothing; a mentee is refused', async ({ page }) => {
    await signInAndSettle(page, otherMentor, PW, '/mentor');
    expect((await (await page.request.get(`/api/relation-health?ids=${relationId}`)).json()).health).toEqual({});
    await page.context().clearCookies();
    await signInAndSettle(page, mentee, PW, '/portal');
    expect((await page.request.get(`/api/relation-health?ids=${relationId}`)).status()).toBe(403);
  });

  test('an admin sees it on the candidate page and in the mentorship list', async ({ page }) => {
    await signInAndSettle(page, admin, PW, '/admin');
    await page.goto(`/admin/candidates/${menteeId}`);
    await expect(page.getByTestId('relation-health')).toBeVisible({ timeout: 30_000 });
    await page.goto('/admin/mentorship');
    await page.getByTestId('mentorship-search').fill(`HB Mentee ${stamp}`);
    const row = page.getByTestId(`mentorship-row-${relationId}`);
    await expect(row.getByTestId(`relation-health-${relationId}`)).toBeVisible({ timeout: 30_000 });
  });
});
