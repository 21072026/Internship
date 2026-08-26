import { test, expect, type Page, type Route } from '@playwright/test';
import { cleanupByEmail, prisma, seedUser, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

const EMPTY_TEXT = 'No meetings or deadlines yet.';

async function signInMentor(page: Page) {
  const email = uniqueEmail('calendar-loading');
  await seedUser(email, 'MentorPass123', 'MENTOR', 'Calendar Loading Mentor');
  await signInAndSettle(page, email, 'MentorPass123', '/mentor');
  return email;
}

function calendarEvent(id: string) {
  return {
    id,
    type: 'meeting',
    title: 'Loading-state meeting',
    who: 'Calendar Event Owner',
    date: new Date().toISOString(),
    link: null,
  };
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('does not show the empty state while existing calendar data is loading', async ({ page }) => {
  const email = await signInMentor(page);
  let release: (() => void) | undefined;
  const responseAllowed = new Promise<void>((resolve) => { release = resolve; });

  await page.route('**/api/calendar-events?*', async (route) => {
    await responseAllowed;
    await route.fulfill({ status: 200, json: { events: [calendarEvent('delayed-event')] } });
  });

  try {
    await page.goto('/mentor/calendar');
    await expect(page.getByTestId('calendar-loading')).toBeVisible();
    await expect(page.getByText(EMPTY_TEXT, { exact: false })).toHaveCount(0);

    release?.();
    await expect(page.getByTestId('calendar-loading')).toHaveCount(0);
    await expect(page.getByText('Calendar Event Owner', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(EMPTY_TEXT, { exact: false })).toHaveCount(0);
  } finally {
    release?.();
    await cleanupByEmail(email);
  }
});

test('shows the empty state only after a successful empty response', async ({ page }) => {
  const email = await signInMentor(page);
  let release: (() => void) | undefined;
  const responseAllowed = new Promise<void>((resolve) => { release = resolve; });

  await page.route('**/api/calendar-events?*', async (route) => {
    await responseAllowed;
    await route.fulfill({ status: 200, json: { events: [] } });
  });

  try {
    await page.goto('/mentor/calendar');
    await expect(page.getByTestId('calendar-loading')).toBeVisible();
    await expect(page.getByText(EMPTY_TEXT, { exact: false })).toHaveCount(0);

    release?.();
    await expect(page.getByTestId('calendar-loading')).toHaveCount(0);
    await expect(page.getByText(EMPTY_TEXT, { exact: false })).toBeVisible();
  } finally {
    release?.();
    await cleanupByEmail(email);
  }
});

test('does not flash the empty state while a navigated range is loading', async ({ page }) => {
  const email = await signInMentor(page);
  let requestCount = 0;
  let releaseSecond: (() => void) | undefined;
  const secondResponseAllowed = new Promise<void>((resolve) => { releaseSecond = resolve; });

  await page.route('**/api/calendar-events?*', async (route) => {
    requestCount += 1;
    if (requestCount === 1) {
      await route.fulfill({ status: 200, json: { events: [calendarEvent('initial-event')] } });
      return;
    }
    await secondResponseAllowed;
    await route.fulfill({ status: 200, json: { events: [] } });
  });

  try {
    await page.goto('/mentor/calendar');
    await expect(page.getByText('Calendar Event Owner', { exact: true }).first()).toBeVisible();

    await page.getByRole('button', { name: 'next', exact: true }).click();
    await expect(page.getByTestId('calendar-loading')).toBeVisible();
    await expect(page.getByText(EMPTY_TEXT, { exact: false })).toHaveCount(0);
    await expect(page.getByText('Calendar Event Owner', { exact: true })).toHaveCount(0);

    releaseSecond?.();
    await expect(page.getByTestId('calendar-loading')).toHaveCount(0);
    await expect(page.getByText(EMPTY_TEXT, { exact: false })).toBeVisible();
  } finally {
    releaseSecond?.();
    await cleanupByEmail(email);
  }
});

test('shows an API error and retries the current calendar range', async ({ page }) => {
  const email = await signInMentor(page);
  let requestCount = 0;
  let releaseRetry: (() => void) | undefined;
  const retryResponseAllowed = new Promise<void>((resolve) => { releaseRetry = resolve; });

  await page.route('**/api/calendar-events?*', async (route: Route) => {
    requestCount += 1;
    if (requestCount === 1) {
      await route.fulfill({ status: 503, json: { error: 'Unavailable' } });
      return;
    }
    await retryResponseAllowed;
    await route.fulfill({ status: 200, json: { events: [calendarEvent('retried-event')] } });
  });

  try {
    await page.goto('/mentor/calendar');
    await expect(page.getByTestId('calendar-load-error')).toBeVisible();
    await expect(page.getByTestId('calendar-retry')).toBeVisible();
    await expect(page.getByText(EMPTY_TEXT, { exact: false })).toHaveCount(0);

    await page.getByTestId('calendar-retry').click();
    await expect(page.getByTestId('calendar-loading')).toBeVisible();
    await expect(page.getByTestId('calendar-load-error')).toHaveCount(0);

    releaseRetry?.();
    await expect(page.getByText('Calendar Event Owner', { exact: true }).first()).toBeVisible();
    expect(requestCount).toBe(2);
  } finally {
    releaseRetry?.();
    await cleanupByEmail(email);
  }
});
