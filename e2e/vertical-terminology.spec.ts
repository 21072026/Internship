import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { defaultTemplateForVertical, templateStages } from '../src/lib/programTemplates';

// Vertical terminology overlay in the live UI (#2354, epic #2348). A MARKETING
// admin sees "Leads" where an INTERNSHIP admin sees "Candidates" — same page,
// different vocabulary, driven only by Organization.vertical. INTERNSHIP is a
// strict no-op (the overlay is empty), asserted here so the change is provably
// invisible to today's product.
//
// #2426/#2427 extend that to the two screens a marketing tenant's own
// capabilities open: /admin/companies and the admin stage board. Their
// acceptance is a NEGATIVE one ("no mentorship word is left"), so the check is
// the rendered text of the whole content region, not a handful of strings —
// a getByText assertion per key would keep passing while the paragraph next to
// it still said "internship". `innerText` is what the browser actually paints,
// which is the point: the dictionary is merged client-side, so grepping the
// server's HTML would prove nothing.

/** The words #2394 says a MARKETING tenant must never read. */
const MENTORSHIP_WORDS = /mentee|mentor|internship/i;

/** The page's own content region — the sidebar and its nav are chrome (#2501). */
function mainText(page: Page) {
  return page.locator('#main-content').innerText();
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function adminIn(vertical: string) {
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const org = await prisma.organization.create({
    data: { name: `Term ${vertical} ${stamp}`, slug: `term-${stamp}`, vertical },
  });
  const email = uniqueEmail(`term-${vertical.toLowerCase()}`);
  const admin = await seedUser(email, 'TermPass123', 'ADMIN', `${vertical} Admin`);
  await prisma.user.update({ where: { id: admin.id }, data: { orgId: org.id } });
  return { org, email, adminId: admin.id };
}

/**
 * Enough rows for the two screens to render their FULL vocabulary: a company
 * with a need (both counter badges), and one relation so the board draws
 * columns and a group heading instead of its empty state.
 *
 * The stage rows are the vertical's own preset — the same thing
 * `provisionStagePreset()` writes when an org is created through the API
 * (#2353). Without them a MARKETING org falls back to the canonical internship
 * stage keys and the board's column headers read "Internship in progress",
 * which no overlay is allowed to fix (stage names come from the template's own
 * labels through `stageLabel()`, never from a second translation layer).
 */
async function seedFunnelFixture(orgId: string, vertical: string, personPrefix: string) {
  const template = defaultTemplateForVertical(vertical);
  const stages = template ? templateStages(template, 'en') : [];
  if (stages.length > 0) {
    await prisma.pipelineStage.createMany({
      data: stages.map((s) => ({
        orgId,
        key: s.key,
        label: s.label,
        order: s.order,
        isTerminal: s.isTerminal,
        isOffPath: s.isOffPath,
        color: s.color,
      })),
    });
  }
  const company = await prisma.company.create({
    data: {
      orgId,
      name: `Acme Retail ${Date.now()}`,
      industry: 'Retail',
      needs: { create: [{ position: 'Seasonal campaign', count: 2, period: '2026 Q1' }] },
    },
  });
  const ownerEmail = uniqueEmail(`${personPrefix}-owner`);
  const personEmail = uniqueEmail(`${personPrefix}-person`);
  const owner = await seedUser(ownerEmail, 'TermPass123', 'MENTOR', 'Robin Owner');
  const person = await seedUser(personEmail, 'TermPass123', 'MENTEE', 'Dana Buyer');
  await prisma.user.updateMany({ where: { id: { in: [owner.id, person.id] } }, data: { orgId } });
  const relation = await prisma.mentorshipRelation.create({
    data: {
      orgId,
      mentorId: owner.id,
      menteeId: person.id,
      companyId: company.id,
      status: 'ACTIVE',
      // The first stage of whatever set this org actually has.
      pipelineStatus: stages[0]?.key ?? 'APPLICATION_100',
    },
  });
  return { relationId: relation.id, companyId: company.id, ownerId: owner.id, personId: person.id, ownerEmail, emails: [ownerEmail, personEmail] };
}

async function teardown(orgId: string, emails: string[], companyId?: string) {
  for (const email of emails) await cleanupByEmail(email);
  if (companyId) await prisma.company.delete({ where: { id: companyId } }).catch(() => {});
  // PipelineStage cascades from the organization.
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
}

test('a MARKETING admin sees "Leads" on the candidates page and in the nav', async ({ page }) => {
  const mkt = await adminIn('MARKETING');
  try {
    await signInAndSettle(page, mkt.email, 'TermPass123', '/admin');
    await page.goto('/admin/candidates');
    await expect(page.getByRole('heading', { name: 'Leads', exact: true })).toBeVisible();
    await expect(page.locator('aside nav').first().getByRole('link', { name: 'Leads', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Candidates', exact: true })).toHaveCount(0);
  } finally {
    await teardown(mkt.org.id, [mkt.email]);
  }
});

test('an INTERNSHIP admin still sees "Candidates" — the overlay is a no-op', async ({ page }) => {
  const intn = await adminIn('INTERNSHIP');
  try {
    await signInAndSettle(page, intn.email, 'TermPass123', '/admin');
    await page.goto('/admin/candidates');
    await expect(page.getByRole('heading', { name: 'Candidates', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Leads', exact: true })).toHaveCount(0);
  } finally {
    await teardown(intn.org.id, [intn.email]);
  }
});

test('a MARKETING admin reads deal language on /admin/companies — and no mentorship word (#2426)', async ({ page }) => {
  const mkt = await adminIn('MARKETING');
  const fixture = await seedFunnelFixture(mkt.org.id, 'MARKETING', 'term-mkt-co');
  try {
    await signInAndSettle(page, mkt.email, 'TermPass123', '/admin');
    await page.goto('/admin/companies');
    await expect(page.getByText('Manage the accounts you sell to and what each one needs')).toBeVisible();
    // The card's two counter badges, and the needs heading above the list.
    await expect(page.getByText('1 deals', { exact: true })).toBeVisible();
    await expect(page.getByText('1 needs', { exact: true })).toBeVisible();
    await expect(page.getByText('Open needs', { exact: true })).toBeVisible();
    expect(await mainText(page)).not.toMatch(MENTORSHIP_WORDS);

    // The page's own two dialogs are part of the page, and a negative assertion
    // that never opens them proves nothing about them: the create/edit form
    // (this button, and the day-one empty state's CTA) said "Internship Quota"
    // / "Internship Needs", and the premium-features modal behind the Sparkles
    // button on every card said "Mentor and mentee features are always free".
    await page.getByRole('button', { name: 'Add company', exact: true }).click();
    await expect(page.locator('#company-form-title')).toBeVisible();
    await expect(page.getByText('Account needs', { exact: true })).toBeVisible();
    await expect(page.getByText('Need quota', { exact: true })).toBeVisible();
    expect(await mainText(page)).not.toMatch(MENTORSHIP_WORDS);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('#company-form-title')).toHaveCount(0);

    await page.getByRole('button', { name: 'Premium features', exact: true }).first().click();
    await expect(page.locator('#company-entitlements-title')).toBeVisible();
    await expect(page.getByText('Rep and lead features are always free')).toBeVisible();
    expect(await mainText(page)).not.toMatch(MENTORSHIP_WORDS);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.locator('#company-entitlements-title')).toHaveCount(0);

    // The THIRD dialog (#2441): what deleting this account costs. It lists the
    // dependants by name, so it reintroduced "1 mentorships" and "1 open
    // positions" on a page whose acceptance is that neither word is left — the
    // exact blind spot the comment above describes, one click before an
    // irreversible action. The fixture gives the account one need and one
    // funnel record, so both sides of the dialog are populated.
    await page.getByTestId(`delete-company-${fixture.companyId}`).click();
    await expect(page.getByTestId('company-delete-cascade')).toContainText('1 open needs');
    await expect(page.getByTestId('company-delete-detach')).toContainText('1 deals');
    expect(await mainText(page)).not.toMatch(MENTORSHIP_WORDS);
    await page.getByTestId('confirm-dialog-cancel').click();
  } finally {
    await teardown(mkt.org.id, [mkt.email, ...fixture.emails], fixture.companyId);
  }
});

test('an INTERNSHIP admin still reads the original /admin/companies strings (#2426)', async ({ page }) => {
  const intn = await adminIn('INTERNSHIP');
  const fixture = await seedFunnelFixture(intn.org.id, 'INTERNSHIP', 'term-int-co');
  try {
    await signInAndSettle(page, intn.email, 'TermPass123', '/admin');
    await page.goto('/admin/companies');
    await expect(page.getByText('Manage partner companies and their internship needs')).toBeVisible();
    await expect(page.getByText('1 mentorships', { exact: true })).toBeVisible();
    await expect(page.getByText('Open positions', { exact: true })).toBeVisible();
    // The mirror of the two dialogs above: unchanged for today's product.
    await page.getByRole('button', { name: 'Add company', exact: true }).click();
    await expect(page.getByText('Internship Needs', { exact: true })).toBeVisible();
    await expect(page.getByText('Internship Quota', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Premium features', exact: true }).first().click();
    await expect(page.getByText('Mentor and mentee features are always free')).toBeVisible();
  } finally {
    await teardown(intn.org.id, [intn.email, ...fixture.emails], fixture.companyId);
  }
});

test('a MARKETING admin reads funnel language on the board — and no mentorship word (#2427)', async ({ page }) => {
  const mkt = await adminIn('MARKETING');
  const fixture = await seedFunnelFixture(mkt.org.id, 'MARKETING', 'term-mkt-bd');
  try {
    await signInAndSettle(page, mkt.email, 'TermPass123', '/admin');
    await page.goto('/admin/board');
    // Wait for the fetch to land: the columns only exist once relations arrive.
    await expect(page.getByTestId('board-columns')).toBeVisible();
    await expect(
      page.getByText('Every lead across every rep — drag a card, or use the stage menu on it, to change its stage')
    ).toBeVisible();
    await expect(page.getByTestId('board-search')).toHaveAttribute('placeholder', 'Find a lead or rep...');
    // The funnel's keys are all non-canonical, so every column lands in the
    // "custom" group — the one heading a provisioned marketing tenant sees.
    await expect(page.getByText('Funnel', { exact: true })).toBeVisible();
    // Stage names come from MARKETING_FUNNEL itself, not from an overlay.
    await expect(page.getByTestId('board-column-title-LEAD_NEW')).toHaveText('New lead');
    expect(await mainText(page)).not.toMatch(MENTORSHIP_WORDS);

    // Every card's owner chip opens a PersonHoverCard that announces the
    // person's role. It is mounted only while open, so the assertion above
    // cannot see it however long it looks — and it read "Mentor" until #2427.
    await page.getByTestId(`person-trigger-${fixture.ownerId}`).click();
    const card = page.getByTestId('person-card');
    await expect(card).toBeVisible();
    await expect(card.getByText('Rep', { exact: true })).toBeVisible();
    expect(await mainText(page)).not.toMatch(MENTORSHIP_WORDS);
  } finally {
    await teardown(mkt.org.id, [mkt.email, ...fixture.emails], fixture.companyId);
  }
});

test('an INTERNSHIP admin still reads the original board strings (#2427)', async ({ page }) => {
  const intn = await adminIn('INTERNSHIP');
  const fixture = await seedFunnelFixture(intn.org.id, 'INTERNSHIP', 'term-int-bd');
  try {
    await signInAndSettle(page, intn.email, 'TermPass123', '/admin');
    await page.goto('/admin/board');
    await expect(page.getByTestId('board-columns')).toBeVisible();
    await expect(
      page.getByText('All mentees across every mentor — drag a card, or use the stage menu on it, to change its stage')
    ).toBeVisible();
    await expect(page.getByTestId('board-search')).toHaveAttribute('placeholder', 'Find a mentee or mentor...');
    await expect(page.getByText('Pre-internship', { exact: true })).toBeVisible();
    await page.getByTestId(`person-trigger-${fixture.ownerId}`).click();
    await expect(page.getByTestId('person-card').getByText('Mentor', { exact: true })).toBeVisible();
  } finally {
    await teardown(intn.org.id, [intn.email, ...fixture.emails], fixture.companyId);
  }
});

// #2557: the screen a rep uses most. The lead detail's relation card said
// "Mentorship / Not assigned to a mentor yet / Mentor", and the first-message
// suggestions in an empty thread welcomed the lead to an internship.
test('a MARKETING admin reads the lead detail with no mentorship word (#2557)', async ({ page }) => {
  const mkt = await adminIn('MARKETING');
  const fixture = await seedFunnelFixture(mkt.org.id, 'MARKETING', 'term-mkt-ld');
  try {
    await signInAndSettle(page, mkt.email, 'TermPass123', '/admin');
    await page.goto(`/admin/candidates/${fixture.personId}`);
    await expect(page.getByText('Owner', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    expect(await mainText(page)).not.toMatch(MENTORSHIP_WORDS);
  } finally {
    await teardown(mkt.org.id, [mkt.email, ...fixture.emails], fixture.companyId);
  }
});

test('a MARKETING rep\'s empty thread suggests a sales opener, not a mentorship welcome (#2557)', async ({ page }) => {
  const mkt = await adminIn('MARKETING');
  const fixture = await seedFunnelFixture(mkt.org.id, 'MARKETING', 'term-mkt-msg');
  try {
    // Any landing: the rep's home is /sales by way of /mentor's redirect, and
    // this test is about the thread, so it waits for the shell rather than
    // the second hop (which a cold `next dev` compiles past the 20s budget).
    await signInAndSettle(page, fixture.ownerEmail, 'TermPass123', '/');
    await page.goto(`/messages/${fixture.relationId}`);
    const suggestions = page.getByTestId('message-suggestions');
    await expect(suggestions).toBeVisible({ timeout: 20_000 });
    await expect(suggestions.getByRole('button', { name: 'Book a demo', exact: true })).toBeVisible();
    expect(await suggestions.innerText()).not.toMatch(MENTORSHIP_WORDS);
    // The full text sits in each button's title — what the box is filled with.
    const titles = await suggestions.getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? ''));
    expect(titles.length).toBe(3);
    for (const title of titles) expect(title).not.toMatch(/mentor|internship|intern\b/i);
    expect(titles.join(' ')).toContain('Dana');
  } finally {
    await teardown(mkt.org.id, [mkt.email, ...fixture.emails], fixture.companyId);
  }
});

test('an INTERNSHIP mentor\'s empty thread keeps the mentorship welcome (#2557)', async ({ page }) => {
  const intn = await adminIn('INTERNSHIP');
  const fixture = await seedFunnelFixture(intn.org.id, 'INTERNSHIP', 'term-int-msg');
  try {
    await signInAndSettle(page, fixture.ownerEmail, 'TermPass123', '/mentor');
    await page.goto(`/messages/${fixture.relationId}`);
    const suggestions = page.getByTestId('message-suggestions');
    await expect(suggestions).toBeVisible({ timeout: 20_000 });
    await expect(suggestions.getByRole('button', { name: 'Intro call', exact: true })).toBeVisible();
  } finally {
    await teardown(intn.org.id, [intn.email, ...fixture.emails], fixture.companyId);
  }
});

// #2558: the screens a SaleVali admin uses to bring the sales team in. Only
// the words change (the Role enum is frozen): MENTOR is a rep, MENTEE a lead.
for (const path of ['/admin/invite', '/admin/users']) {
  test(`a MARKETING admin reads ${path} with no mentorship word (#2558)`, async ({ page }) => {
    const mkt = await adminIn('MARKETING');
    const fixture = await seedFunnelFixture(mkt.org.id, 'MARKETING', `term-mkt-${path.split('/').pop()}`);
    try {
      await signInAndSettle(page, mkt.email, 'TermPass123', '/admin');
      await page.goto(path);
      await expect(page.locator('#main-content h1').first()).toBeVisible({ timeout: 20_000 });
      // The users list is fetched after the first paint: wait for the seeded rep.
      if (path === '/admin/users') await expect(page.getByText('Robin Owner').first()).toBeVisible({ timeout: 20_000 });
      expect(await mainText(page)).not.toMatch(MENTORSHIP_WORDS);
    } finally {
      await teardown(mkt.org.id, [mkt.email, ...fixture.emails], fixture.companyId);
    }
  });
}
