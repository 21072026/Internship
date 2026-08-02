import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

/**
 * Phone-width layout audit (#51 follow-up).
 *
 * Two mechanical rules, checked on the screens this feature touched:
 *   1. the page must not scroll sideways — a horizontal overflow is how a
 *      cramped row announces itself;
 *   2. every visible text box / select must still be wide enough to use. The
 *      regression that prompted this: an "add a task" input sharing a card row
 *      with a button, squeezed to a few pixels on a phone.
 */

const PHONE = { width: 390, height: 844 };
// A text input narrower than this is not usable; the buttons next to it are what
// pushed it there.
const MIN_FIELD_WIDTH = 120;

async function auditLayout(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const problems: string[] = [];
    const viewport = window.innerWidth;
    // 1px of slack: sub-pixel rounding on scaled layouts is not an overflow.
    if (document.documentElement.scrollWidth > viewport + 1) {
      problems.push(`page scrolls sideways: ${document.documentElement.scrollWidth}px > ${viewport}px`);
    }
    const describe = (el: Element) => {
      const testId = el.getAttribute('data-testid');
      const name = el.getAttribute('name') || el.getAttribute('placeholder') || el.getAttribute('aria-label');
      return `${el.tagName.toLowerCase()}${testId ? `[${testId}]` : ''}${name ? `(${name})` : ''}`;
    };
    for (const el of Array.from(document.querySelectorAll('input, select, textarea'))) {
      const type = (el as HTMLInputElement).type;
      // Checkboxes/radios are meant to be small; hidden fields have no box.
      if (type === 'checkbox' || type === 'radio' || type === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.width < 120) problems.push(`${describe(el)} is ${Math.round(rect.width)}px wide`);
      if (rect.right > viewport + 1) problems.push(`${describe(el)} overflows the viewport`);
    }
    return problems;
  });
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('phone width: the project page and project list stay inside the viewport', async ({ browser }) => {
  const mentorEmail = uniqueEmail('rwd-mentor');
  const menteeEmail = uniqueEmail('rwd-mentee');
  const pw = 'Responsive123!';
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Responsive Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Responsive Mentee');

  const project = await prisma.project.create({
    data: {
      name: 'Responsive Project With A Deliberately Long Name',
      ownerType: 'MENTOR',
      ownerUserId: mentor.id,
      technologies: ['TypeScript', 'Next.js', 'Prisma', 'Playwright'],
      repoUrl: 'https://example.com/repo',
      demoUrl: 'https://example.com/demo',
      boardUrl: 'https://example.com/board',
      members: {
        create: [
          { userId: mentor.id, role: 'OWNER' },
          { userId: mentee.id, role: 'MENTEE', functionalRole: 'DEVELOPER' },
        ],
      },
      tasks: {
        create: [
          { title: 'A goal with a fairly long title that has to wrap on a phone', order: 0 },
          { title: 'Find at least one bug', order: 1, assigneeId: mentee.id },
        ],
      },
    },
  });

  const ctx = await browser.newContext({ viewport: PHONE });
  try {
    const page = await ctx.newPage();
    await signInAndSettle(page, mentorEmail, pw, '/mentor');

    for (const path of ['/mentor/projects', `/projects/${project.id}`, '/mentor']) {
      await page.goto(path);
      // The panels on the project page load their own data; let them land before
      // measuring, otherwise the audit runs against a half-empty page.
      await page.waitForLoadState('networkidle');
      expect(await auditLayout(page), `${path} at ${PHONE.width}px`).toEqual([]);
    }

    // The goal composer — the row that used to collapse — is genuinely usable.
    await page.goto(`/projects/${project.id}`);
    await page.waitForLoadState('networkidle');
    // The project page is outside the app shell, so it carries its own header:
    // without one, opening a project on a phone left the screen with no title
    // and no way back into the app.
    await expect(page.getByRole('banner')).toBeVisible();
    const goalInput = page.getByTestId('goal-input');
    await expect(goalInput).toBeVisible();
    const box = await goalInput.boundingBox();
    expect(box!.width).toBeGreaterThan(MIN_FIELD_WIDTH);

    // The collapsed panels are where a cramped row hides: nothing measures a
    // form that is not open yet. Expand the two on this page and re-audit.
    await page.getByTestId('add-weekly-meeting').click();
    await page.getByTestId('toggle-templates').click();
    await expect(page.getByTestId('save-weekly-meeting')).toBeVisible();
    expect(await auditLayout(page), 'project page with its forms open').toEqual([]);
  } finally {
    await ctx.close();
    await prisma.projectTask.deleteMany({ where: { projectId: project.id } });
    await prisma.projectTaskTemplate.deleteMany({ where: { projectId: project.id } });
    await prisma.projectMember.deleteMany({ where: { projectId: project.id } });
    await prisma.conversation.deleteMany({ where: { projectId: project.id } });
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});

test('phone width: a mentee portal and their project stay inside the viewport', async ({ browser }) => {
  const menteeEmail = uniqueEmail('rwd-portal');
  const pw = 'Responsive123!';
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Portal Mentee');
  const owner = await seedUser(uniqueEmail('rwd-owner'), pw, 'MENTOR', 'Portal Owner');

  const project = await prisma.project.create({
    data: {
      name: 'Portal Project',
      ownerType: 'MENTOR',
      ownerUserId: owner.id,
      isPublic: true,
      members: {
        create: [
          { userId: owner.id, role: 'OWNER' },
          { userId: mentee.id, role: 'MENTEE', functionalRole: 'TESTER' },
        ],
      },
    },
  });

  const ctx = await browser.newContext({ viewport: PHONE });
  try {
    const page = await ctx.newPage();
    await signInAndSettle(page, menteeEmail, pw, '/portal');
    for (const path of ['/portal', `/projects/${project.id}`, '/projects']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      expect(await auditLayout(page), `${path} at ${PHONE.width}px`).toEqual([]);
    }
  } finally {
    await ctx.close();
    await prisma.projectMember.deleteMany({ where: { projectId: project.id } });
    await prisma.conversation.deleteMany({ where: { projectId: project.id } });
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
    await cleanupByEmail(menteeEmail);
    await prisma.user.delete({ where: { id: owner.id } }).catch(() => {});
  }
});
