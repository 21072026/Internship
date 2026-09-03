import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// The public AI transparency page (#2034) and the ✨ marker that has to sit on
// every rendered model output.

test('landing footer links to the AI page', async ({ page }) => {
  await page.goto('/');
  const link = page.locator('footer').getByRole('link', { name: 'How we use AI' });
  await expect(link).toHaveAttribute('href', '/ai');
  await link.click();
  await expect(page).toHaveURL(/\/ai$/);
  await expect(page.getByRole('heading', { name: 'How we use AI', level: 1 })).toBeVisible();
});

test('the AI page names every task and what it withholds', async ({ page }) => {
  await page.goto('/ai');
  // All five registered AI tasks, not just the CV one the privacy notice used
  // to mention on its own.
  await expect(page.getByTestId('ai-tasks').locator('li')).toHaveCount(5);
  await expect(page.getByRole('heading', { name: 'A person decides, always' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Model training' })).toBeVisible();
  // The honesty section is the point of the page: it must stay non-empty, and
  // the page must not have quietly grown a certification claim.
  await expect(page.getByTestId('ai-not-yet').locator('li').first()).toBeVisible();
  await expect(page.getByText(/no SOC 2 or ISO 27001 certification/)).toBeVisible();
});

test('the privacy notice discloses the AI purposes and links to the AI page', async ({ page }) => {
  await page.goto('/privacy');
  await expect(page.getByRole('heading', { name: 'AI-assisted features' })).toBeVisible();
  await expect(page.getByTestId('privacy-ai-link')).toHaveAttribute('href', '/ai');
});

for (const [locale, heading] of [
  ['tr', 'Yapay zekâyı nasıl kullanıyoruz'],
  ['de', 'Wie wir KI einsetzen'],
] as const) {
  test(`the AI page is translated (${locale})`, async ({ page }) => {
    await page.goto('/ai');
    await page.evaluate((l) => { document.cookie = `locale=${l};path=/`; }, locale);
    await page.reload();
    await expect(page.getByRole('heading', { name: heading, level: 1 }))
      .toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('ai-tasks').locator('li')).toHaveCount(5);
  });
}

// Rendering a real generated string in a browser needs a provider key, which CI
// does not have and must not have. What can be checked without one — and what
// actually rots — is whether a surface that renders model output still imports
// the marker. A new AI surface added without it fails here.
test('every surface that renders model output carries the ✨ marker', () => {
  const surfaces = [
    'src/components/CvFeedback.tsx',
    'src/components/InterviewPrep.tsx',
    'src/components/InteractionSummary.tsx',
    'src/components/CvSuggestPanel.tsx',
    'src/components/admin/AssignMentorInline.tsx',
  ];
  for (const file of surfaces) {
    const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
    expect(source, `${file} renders AI output and must render <AiBadge />`).toContain('AiBadge');
  }

  // The badge itself keeps all three layers: an icon is not a label.
  const badge = fs.readFileSync(path.join(process.cwd(), 'src/components/AiBadge.tsx'), 'utf8');
  expect(badge).toContain('b.srLabel');
  expect(badge).toContain('title={b.tooltip}');
});
