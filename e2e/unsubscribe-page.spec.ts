import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { makeUnsubscribeToken } from '../src/lib/unsubscribeToken';
import { getDictionary } from '../src/i18n/dictionaries';

// #1290 — the maintainer's headline requirement: clicking the unsubscribe link
// in a mail footer must unsubscribe you, immediately, with no sign-in and no
// Save step. Every case below runs signed OUT; the signed token in the URL is
// the only credential in play.
//
// The page is a client component that POSTs on mount (a mutating GET would be
// triggered by Outlook Safe Links and every AV gateway that prefetches URLs in
// a message), so the assertions poll the DB rather than trusting the render.

test.afterAll(async () => {
  await prisma.$disconnect();
});

function prefsOf(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

async function readPref(userId: string, key: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { notificationPrefs: true } });
  return prefsOf(u?.notificationPrefs)[key];
}

test('a footer link unsubscribes on arrival — no sign-in, no Save', { tag: '@smoke' }, async ({ page }) => {
  const email = uniqueEmail('unsub-page');
  const user = await seedUser(email, 'UnsubPass123', 'MENTEE', 'Unsub Page');
  try {
    const token = makeUnsubscribeToken(user.id, 'meeting_reminders');
    await page.goto(`/u/${encodeURIComponent(token)}`);

    await expect(page.getByTestId('unsub-done')).toBeVisible();
    await expect(page.getByTestId('unsubscribe-done')).toBeVisible();

    // The write, not the copy, is the promise.
    await expect
      .poll(() => readPref(user.id, 'email:meeting_reminders'), { timeout: 15_000 })
      .toBe(false);

    // Nothing on this page asks for credentials.
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /save/i })).toHaveCount(0);
  } finally {
    await cleanupByEmail(email);
  }
});

test('undo flips it straight back on', async ({ page }) => {
  const email = uniqueEmail('unsub-undo');
  const user = await seedUser(email, 'UnsubPass123', 'MENTEE', 'Unsub Undo');
  try {
    const token = makeUnsubscribeToken(user.id, 'digests');
    await page.goto(`/u/${encodeURIComponent(token)}`);
    await expect.poll(() => readPref(user.id, 'email:digests'), { timeout: 15_000 }).toBe(false);

    await page.getByTestId('unsub-undo').click();
    await expect(page.getByTestId('unsub-undone')).toBeVisible();
    await expect.poll(() => readPref(user.id, 'email:digests'), { timeout: 15_000 }).toBe(true);
  } finally {
    await cleanupByEmail(email);
  }
});

test('the preference centre offers every non-essential group and saves instantly', async ({ page }) => {
  const email = uniqueEmail('unsub-centre');
  const user = await seedUser(email, 'UnsubPass123', 'MENTEE', 'Unsub Centre');
  try {
    const token = makeUnsubscribeToken(user.id, 'task_reminders');
    await page.goto(`/u/${encodeURIComponent(token)}`);
    await expect(page.getByTestId('unsub-center')).toBeVisible();
    await expect(page.getByTestId('unsubscribe-preferences')).toBeVisible();

    // Eleven of the twelve groups are switchable; account_security is a
    // read-only "always sent" row with no input at all.
    await expect(page.locator('[data-testid^="unsub-group-toggle-"]')).toHaveCount(11);
    await expect(page.getByTestId('unsub-group-toggle-account_security')).toHaveCount(0);
    await expect(page.getByTestId('unsub-group-essential-account_security')).toBeVisible();

    // A group nobody has touched is on by default (resolution rule 6).
    const opportunities = page.getByTestId('unsub-group-toggle-opportunities');
    await expect(opportunities).toBeChecked();
    await opportunities.uncheck();
    await expect
      .poll(() => readPref(user.id, 'email:opportunities'), { timeout: 15_000 })
      .toBe(false);

    // The instant save is a single-group write: the group the token was minted
    // for is still the only other key in the blob.
    const u = await prisma.user.findUnique({ where: { id: user.id }, select: { notificationPrefs: true } });
    expect(prefsOf(u?.notificationPrefs)['email:task_reminders']).toBe(false);
  } finally {
    await cleanupByEmail(email);
  }
});

test('a preference-centre token changes nothing on its own', async ({ page }) => {
  const email = uniqueEmail('unsub-all');
  const user = await seedUser(email, 'UnsubPass123', 'MENTEE', 'Unsub All');
  try {
    // The footer's second anchor. Somebody clicking "manage my preferences" is
    // asking to choose, not to be cut off — so this token must not apply
    // anything, and the page must not claim it did.
    const token = makeUnsubscribeToken(user.id, 'all');
    await page.goto(`/u/${encodeURIComponent(token)}`);

    await expect(page.getByTestId('unsub-center')).toBeVisible();
    await expect(page.getByTestId('unsub-done')).toHaveCount(0);

    const u = await prisma.user.findUnique({ where: { id: user.id }, select: { notificationPrefs: true } });
    const keys = Object.keys(prefsOf(u?.notificationPrefs)).filter((k) => k.startsWith('email:'));
    expect(keys).toEqual([]);
  } finally {
    await cleanupByEmail(email);
  }
});

test('a token that does not verify gets a plain dead-end, not a stack trace', async ({ page }) => {
  await page.goto('/u/not-a-real-token');
  await expect(page.getByTestId('unsub-error')).toBeVisible();
  await expect(page.getByTestId('unsubscribe-invalid')).toBeVisible();
  await expect(page.getByTestId('unsub-open-settings')).toBeVisible();
  // No preference centre for a token that proves nothing about who this is.
  await expect(page.getByTestId('unsub-center')).toHaveCount(0);
});

// The page is read SIGNED OUT, so there is no session and no locale cookie to
// infer a language from: it renders in whatever the API says the recipient's
// language is. Before this it always rendered in the default locale, which meant
// a Turkish reader got a Turkish footer link and an English page.
test('the page renders in the recipient’s own language, not the default one', async ({ page }) => {
  const email = uniqueEmail('unsub-locale');
  const user = await seedUser(email, 'UnsubPass123', 'MENTEE', 'Unsub Locale');
  try {
    // The same thing the mail footer reads to pick the language it writes in.
    await prisma.user.update({ where: { id: user.id }, data: { preferredLanguage: 'tr' } });

    const token = makeUnsubscribeToken(user.id, 'digests');
    await page.goto(`/u/${encodeURIComponent(token)}`);
    await expect(page.getByTestId('unsub-center')).toBeVisible();

    // Asserted against the dictionary rather than a pasted string, so rewording
    // the copy cannot make this spec lie about which language is on screen.
    const tr = getDictionary('tr');
    const en = getDictionary('en');
    await expect(page.getByText(tr.unsubscribe.centerTitle, { exact: true })).toBeVisible();
    await expect(page.getByText(en.unsubscribe.centerTitle, { exact: true })).toHaveCount(0);
    // The group names come from the same dictionary — the whole page moved, not
    // one heading.
    await expect(page.getByText(tr.emailGroups.digests.name, { exact: true })).toBeVisible();

    // …and the document says so too, so a screen reader does not read Turkish
    // out in an English voice.
    await expect.poll(() => page.locator('html').getAttribute('lang')).toBe('tr');
  } finally {
    await cleanupByEmail(email);
  }
});
