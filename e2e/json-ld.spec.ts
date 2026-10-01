import { test, expect, type Page } from '@playwright/test';

// Structured data (#1382): the landing's FAQ as a schema.org FAQPage (from the
// same array that renders the list, so the two cannot drift), the product as
// an Organization whose founder is a PERSON, and a BreadcrumbList on sub-pages.

type Ld = Record<string, unknown> & { '@type': string };

async function ldBlocks(page: Page, path: string): Promise<Ld[]> {
  await page.goto(path);
  const raw = await page.locator('script[type="application/ld+json"]').allTextContents();
  return raw.map((r) => JSON.parse(r) as Ld);
}

const byType = (blocks: Ld[], type: string) => blocks.filter((b) => b['@type'] === type);

test('the landing FAQ is a FAQPage with exactly the questions on the page, in the reader’s language', async ({ page, baseURL }) => {
  const blocks = await ldBlocks(page, '/');
  const [faq] = byType(blocks, 'FAQPage');
  expect(faq).toBeTruthy();
  const questions = faq.mainEntity as { '@type': string; name: string; acceptedAnswer: { text: string } }[];
  // One entry per rendered question — the page's <details> are the FAQ items.
  const rendered = await page.locator('details > summary').allTextContents();
  expect(questions.length).toBe(rendered.length);
  expect(questions.length).toBeGreaterThan(0);
  for (const q of questions) {
    expect(q['@type']).toBe('Question');
    expect(q.acceptedAnswer.text.length).toBeGreaterThan(0);
  }
  expect(rendered.map((s) => s.trim())).toContain(questions[0].name);

  // The product is an Organization; its founder is a person, never a company.
  const [org] = byType(blocks, 'Organization');
  expect(org).toMatchObject({ name: 'Internship CRM', founder: { '@type': 'Person', name: 'Mehmet Erşahin' } });
  expect(String(org.url)).toMatch(/^https?:\/\//);
  expect(String(org.logo)).toMatch(/^https?:\/\//);
  // No invented numbers anywhere in the structured data.
  expect(JSON.stringify(blocks)).not.toContain('aggregateRating');
  // The landing is the root, not a breadcrumb.
  expect(byType(blocks, 'BreadcrumbList')).toHaveLength(0);

  await page.context().addCookies([{ name: 'locale', value: 'tr', url: baseURL! }]);
  const tr = byType(await ldBlocks(page, '/'), 'FAQPage')[0].mainEntity as { name: string }[];
  expect(tr.length).toBe(questions.length);
  expect(tr[0].name).not.toBe(questions[0].name);
  expect((await page.locator('details > summary').allTextContents()).map((s) => s.trim())).toContain(tr[0].name);
});

test('a sub-page carries a two-step BreadcrumbList named after its heading', async ({ page }) => {
  const blocks = await ldBlocks(page, '/features');
  const [crumbs] = byType(blocks, 'BreadcrumbList');
  const items = crumbs.itemListElement as { position: number; name: string; item: string }[];
  expect(items.map((i) => i.position)).toEqual([1, 2]);
  expect(items[0].name).toBe('Home');
  expect(new URL(items[0].item).pathname).toBe('/');
  expect(new URL(items[1].item).pathname).toBe('/features');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(items[1].name);
  // The Organization rides on every public page, not only the landing.
  expect(byType(blocks, 'Organization')).toHaveLength(1);
});
