import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// WCAG 3.1.2 Language of Parts (#2864): text whose language is KNOWN and may
// differ from the interface carries its own `lang` — the language switcher
// (each language named in itself) and the per-language fields an admin fills
// (here: the goal template form, which every EN/TR/DE editor shares in shape).
test('the language switcher and per-language fields declare their language', async ({ page }) => {
  await gotoSettled(page, '/features');
  const switcher = page.getByTestId('language-switcher').first();
  for (const [code, name] of [['en', 'English'], ['tr', 'Türkçe'], ['de', 'Deutsch']] as const) {
    const button = switcher.getByRole('button', { name: `${code} ${name}`, exact: true });
    await expect(button).toHaveAttribute('lang', code);
  }

  const email = uniqueEmail('lang-parts');
  const pw = 'LangParts123';
  await seedUser(email, pw, 'ADMIN', 'Language Parts');
  try {
    await signInAndSettle(page, email, pw, '/admin');
    await gotoSettled(page, '/admin/goal-templates');
    for (const code of ['en', 'tr', 'de']) {
      await expect(page.getByTestId(`new-template-${code}`)).toHaveAttribute('lang', code);
    }
  } finally {
    await cleanupByEmail(email);
  }
});
