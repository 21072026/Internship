import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// Configurable board WIP limits (#1439).
//
// The limit used to be a constant in the page: at 308 relations every one of the
// thirteen columns showed the amber warning, so the chip pointed nowhere. What
// is asserted here is the behaviour that replaced it — a limit an org sets per
// stage, a stage that can opt out of warnings altogether, and a board that says
// so once the limit no longer separates anything.
//
// Every count assertion narrows the board with its search box first: the admin
// board shows every relation in the database, so a seeded column is only
// countable once the search leaves nothing else in it.

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

// The default stage keys are named here rather than resolved: this spec seeds
// against the built-in pipeline, and a test that resolved them would assert
// nothing about which column its cards landed in.
const STAGE_A = 'APPLICATION_100';
const STAGE_B = 'APPROVAL_PENDING_220';
const STAGE_C = 'INTERVIEW_PENDING_250';

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  await prisma.$disconnect();
});

/** `count` mentees in `stage`, all named with `token` so the search can isolate them. */
async function seedColumn(token: string, stage: string, count: number, orgId: string | null) {
  const emails: string[] = [];
  const relationIds: string[] = [];
  const mentorEmail = uniqueEmail(`wip-mentor-${stage.toLowerCase()}`);
  const mentor = await seedUser(mentorEmail, 'MentorPass123!', 'MENTOR', `${token} Mentor`);
  emails.push(mentorEmail);
  await prisma.user.update({ where: { id: mentor.id }, data: { orgId } });
  for (let i = 0; i < count; i++) {
    const menteeEmail = uniqueEmail(`wip-mentee-${stage.toLowerCase()}-${i}`);
    const mentee = await seedUser(menteeEmail, 'MenteePass123!', 'MENTEE', `${token} Aday ${stage} ${i}`);
    emails.push(menteeEmail);
    await prisma.user.update({ where: { id: mentee.id }, data: { orgId } });
    const rel = await prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: mentee.id, orgId, status: 'ACTIVE', pipelineStatus: stage },
    });
    relationIds.push(rel.id);
  }
  return { emails, relationIds };
}

async function cleanupSeed(seeded: { emails: string[]; relationIds: string[] }) {
  await prisma.mentorshipRelation.deleteMany({ where: { id: { in: seeded.relationIds } } });
  for (const email of seeded.emails) await cleanupByEmail(email);
}

test('a per-stage limit is what the board applies, and 0 silences one column', async ({ page }) => {
  test.slow();
  const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { orgId: true } });
  const orgId = admin?.orgId ?? null;
  const token = `WipZeta${Date.now()}`;
  const a = await seedColumn(token, STAGE_A, 2, orgId);
  const b = await seedColumn(token, STAGE_B, 2, orgId);
  const c = await seedColumn(token, STAGE_C, 2, orgId);

  try {
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');

    // Three columns of two, each with a limit of one: every column that holds
    // anybody is over its limit, which is the state the issue was filed about.
    const tight = await page.request.put('/api/admin/stage-sla', {
      data: {
        slas: [
          { stageKey: STAGE_A, days: null, wipLimit: 1 },
          { stageKey: STAGE_B, days: null, wipLimit: 1 },
          { stageKey: STAGE_C, days: null, wipLimit: 1 },
        ],
      },
    });
    expect(tight.ok()).toBeTruthy();
    // A WIP limit on its own is enough to keep the row — the service level is
    // still empty, and clearing it must not have deleted the board setting.
    const stored = await (await page.request.get('/api/admin/stage-sla')).json();
    const rowA = stored.stages.find((s: { key: string }) => s.key === STAGE_A);
    expect(rowA.wipLimit).toBe(1);
    expect(rowA.days ?? null).toBeNull();

    await page.goto('/admin/board');
    const search = page.getByTestId('board-search');
    await expect(search).toBeVisible({ timeout: 20_000 });
    await search.fill(token);

    // Not thirteen amber chips: one line saying the limit does not fit this
    // board, and a link to where it is changed.
    const banner = page.getByTestId('board-wip-saturated');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner.getByRole('link')).toHaveAttribute('href', '/admin/settings');
    await expect(page.getByTestId(`board-column-count-${STAGE_A}`)).toHaveText('2');

    // Two of the three stages opt out with a 0; the third keeps its limit. Now
    // only one column can breach, so the warning means something again.
    const relaxed = await page.request.put('/api/admin/stage-sla', {
      data: {
        slas: [
          { stageKey: STAGE_A, days: null, wipLimit: 1 },
          { stageKey: STAGE_B, days: null, wipLimit: 0 },
          { stageKey: STAGE_C, days: null, wipLimit: 0 },
        ],
      },
    });
    expect(relaxed.ok()).toBeTruthy();

    await page.goto('/admin/board');
    await expect(page.getByTestId('board-search')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('board-search').fill(token);

    await expect(page.getByTestId('board-wip-saturated')).toHaveCount(0);
    // The chip names the limit it passed, so the warning can be acted on.
    await expect(page.getByTestId(`board-column-count-${STAGE_A}`)).toContainText('2 / 1');
    await expect(page.getByTestId(`board-column-count-${STAGE_A}`)).toHaveAttribute('title', /1/);
    // A stage limited to 0 never turns amber, however deep it is.
    await expect(page.getByTestId(`board-column-count-${STAGE_B}`)).toHaveText('2');
    await expect(page.getByTestId(`board-column-count-${STAGE_C}`)).toHaveText('2');
  } finally {
    if (orgId) await prisma.stageSla.deleteMany({ where: { orgId } });
    await cleanupSeed(a);
    await cleanupSeed(b);
    await cleanupSeed(c);
  }
});

test('with nothing configured the board keeps the limit it shipped with', async ({ page }) => {
  test.slow();
  const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { orgId: true } });
  const orgId = admin?.orgId ?? null;
  // No stage rows, no setting written: an installation that configures nothing
  // must see exactly the board it saw before this became configurable.
  if (orgId) await prisma.stageSla.deleteMany({ where: { orgId } });
  const token = `WipEta${Date.now()}`;
  const deep = await seedColumn(token, STAGE_A, 9, orgId);

  try {
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');
    await page.goto('/admin/board');
    await expect(page.getByTestId('board-search')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('board-search').fill(token);

    // Nine in a column, the inherited default is eight.
    await expect(page.getByTestId(`board-column-count-${STAGE_A}`)).toContainText('9 / 8', { timeout: 15_000 });
    await expect(page.getByTestId('board-wip-saturated')).toHaveCount(0);
  } finally {
    await cleanupSeed(deep);
  }
});

test('the org-wide limit round-trips through the settings form', async ({ page }) => {
  const adminEmail = uniqueEmail('wip-settings-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Wip Settings Admin');
  // Whatever the API resolves right now, put back the same way it was changed
  // (a Prisma cleanup would edit the wrong database on a deployed BASE_URL).
  let original: string | null = null;

  try {
    await signInAndSettle(page, adminEmail, 'AdminPass123', '/admin');
    original = (await (await page.request.get('/api/admin/settings')).json()).settings.boardWipLimit ?? null;
    expect(original).toMatch(/^\d{1,4}$/);

    await page.goto('/admin/settings');
    // AdminNav renders its own sidebar input[type="search"] on every admin page
    // and this form holds several number inputs — hence the testid.
    const field = page.getByTestId('board-wip-limit');
    await expect(field).toHaveValue(String(original), { timeout: 20_000 });
    await expect(field).toHaveAttribute('type', 'number');

    // 0 is a real answer and must survive the round trip: it is how an operator
    // switches the warnings off instead of picking a number they will ignore.
    await field.fill('0');
    await page
      .locator('form')
      .filter({ has: page.getByTestId('board-wip-limit') })
      .getByRole('button', { name: 'Save settings' })
      .click();

    await expect
      .poll(async () => (await (await page.request.get('/api/admin/settings')).json()).settings.boardWipLimit, {
        timeout: 15_000,
      })
      .toBe('0');
    // The stage editor's empty WIP boxes now say the inherited answer is "off"
    // rather than showing a number that no longer applies.
    await page.goto('/admin/settings');
    await expect(page.getByTestId('board-wip-limit')).toHaveValue('0', { timeout: 20_000 });
    await expect(page.getByTestId(`wip-${STAGE_A}`)).toHaveAttribute('placeholder', 'off');
  } finally {
    if (original !== null) {
      await page.request.put('/api/admin/settings', { data: { boardWipLimit: original } }).catch(() => {});
    }
    await cleanupByEmail(adminEmail);
  }
});
