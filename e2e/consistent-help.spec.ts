import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// WCAG 3.2.6 Consistent Help (#2864): the signed-in help mechanism is the
// "Report a problem" button (FeedbackWidget, mounted once in app/providers.tsx).
// The criterion asks that it sits in the same relative place on every page that
// has it, so this walks two pages of each role shell and compares where the
// button is — same right/bottom offset, every time. The VPAT row cites this spec.
const SHELLS = [
  { role: 'ADMIN' as const, landing: '/admin', pages: ['/admin', '/admin/companies'] },
  { role: 'MENTOR' as const, landing: '/mentor', pages: ['/mentor', '/mentor/interactions'] },
  { role: 'MENTEE' as const, landing: '/portal', pages: ['/portal', '/portal/profile'] },
];

async function helpPosition(page: Page) {
  const button = page.getByTestId('feedback-open');
  await expect(button).toBeVisible({ timeout: 15_000 });
  const box = await button.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport) throw new Error('feedback button has no box');
  return {
    right: Math.round(viewport.width - (box.x + box.width)),
    bottom: Math.round(viewport.height - (box.y + box.height)),
  };
}

for (const shell of SHELLS) {
  test(`consistent help: the report button sits in one place across the ${shell.role} shell`, async ({ page }) => {
    const email = uniqueEmail(`help-${shell.role.toLowerCase()}`);
    const pw = 'ConsistentHelp123';
    await seedUser(email, pw, shell.role, `Help ${shell.role}`);
    try {
      await signInAndSettle(page, email, pw, shell.landing);
      const positions = [];
      for (const path of shell.pages) {
        await gotoSettled(page, path);
        positions.push(await helpPosition(page));
      }
      for (const p of positions.slice(1)) expect(p).toEqual(positions[0]);
    } finally {
      await cleanupByEmail(email);
    }
  });
}
