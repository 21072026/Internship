import { test, expect, type Route } from '@playwright/test';
import { AsyncSection, type AsyncSectionSkeleton } from '../src/components/ui/AsyncSection';
import { cleanupByEmail, seedUser, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

interface TestNode { type?: unknown; props?: Record<string, unknown> }

function resolveNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(resolveNode);
  if (!node || typeof node !== 'object' || !('type' in node)) return node;
  const marker = node as TestNode;
  if (typeof marker.type === 'function') return resolveNode(marker.type(marker.props ?? {}));
  if (marker.type && typeof marker.type === 'object' && 'render' in marker.type) {
    const render = (marker.type as { render: (props: Record<string, unknown>, ref: null) => unknown }).render;
    return resolveNode(render(marker.props ?? {}, null));
  }
  return {
    ...marker,
    props: { ...marker.props, children: resolveNode(marker.props?.children) },
  };
}

function allNodes(node: unknown): TestNode[] {
  if (Array.isArray(node)) return node.flatMap(allNodes);
  if (!node || typeof node !== 'object') return [];
  const marker = node as TestNode;
  return [marker, ...allNodes(marker.props?.children)];
}

function textContent(node: unknown): string {
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';
  return textContent((node as TestNode).props?.children);
}

const render = (props: Partial<Parameters<typeof AsyncSection>[0]> = {}) => resolveNode(AsyncSection({
    loading: false,
    error: null,
    empty: false,
    emptyText: 'genuinely empty',
    children: 'loaded content',
    ...props,
  }));

test('AsyncSection enforces state precedence, retries, and renders every skeleton variant', { tag: '@smoke' }, () => {
  const loading = render({ loading: true, error: 'failed', empty: true });
  expect(allNodes(loading).some((node) => node.props?.['data-testid'] === 'async-section-loading')).toBe(true);
  expect(textContent(loading)).not.toContain('failed');
  expect(textContent(loading)).not.toContain('genuinely empty');

  const error = render({ error: 'failed', empty: true, retryText: 'Retry', onRetry: () => {} });
  expect(allNodes(error).some((node) => node.props?.['data-testid'] === 'async-section-error')).toBe(true);
  expect(textContent(error)).toContain('failed');
  expect(textContent(error)).toContain('Retry');
  expect(textContent(error)).not.toContain('genuinely empty');
  expect(textContent(error)).not.toContain('loaded content');

  const withoutRetry = render({ error: 'failed' });
  expect(allNodes(withoutRetry).some((node) => node.type === 'button')).toBe(false);

  const empty = render({ empty: true });
  expect(allNodes(empty).some((node) => node.props?.['data-testid'] === 'async-section-empty')).toBe(true);
  expect(textContent(empty)).toContain('genuinely empty');
  expect(textContent(empty)).not.toContain('loaded content');
  expect(textContent(render())).toContain('loaded content');

  let retries = 0;
  const errorNode = resolveNode(AsyncSection({
    loading: false,
    error: 'failed',
    empty: false,
    emptyText: 'empty',
    retryText: 'Retry',
    onRetry: () => { retries += 1; },
    children: 'loaded content',
  }));
  const retryButton = allNodes(errorNode).find((node) => node.type === 'button');
  (retryButton?.props?.onClick as (() => void))();
  expect(retries).toBe(1);

  for (const variant of ['list', 'card', 'stats'] satisfies AsyncSectionSkeleton[]) {
    expect(allNodes(render({ loading: true, skeleton: variant })).some(
      (node) => node.props?.['data-skeleton'] === variant
    )).toBe(true);
  }
});

test('portal interactions uses loading, error, retry and genuine empty states', async ({ page }) => {
  const email = uniqueEmail('async-interactions');
  await seedUser(email, 'AsyncPass123!', 'MENTEE', 'Async Mentee');
  const pending: Route[] = [];

  try {
    await signInAndSettle(page, email, 'AsyncPass123!', '/portal');
    await page.evaluate(() => { document.cookie = 'locale=tr;path=/'; });
    await page.route('**/api/interactions', async (route) => { pending.push(route); });
    await page.goto('/portal/interactions');

    await expect(page.getByRole('heading', { name: 'Etkileşim Kayıtları' })).toBeVisible();
    await expect(page.getByText('Mentörünle olan etkileşim geçmişin')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Interaction Logs' })).toHaveCount(0);
    await expect.poll(() => pending.length).toBe(1);
    await expect(page.getByTestId('async-section-loading')).toBeVisible();
    await expect(page.getByText('No interactions logged yet')).toHaveCount(0);
    await pending[0].fulfill({ status: 500, json: { error: 'Failed' } });
    await expect(page.getByTestId('async-section-error')).toBeVisible();
    await expect(page.getByText('No interactions logged yet')).toHaveCount(0);

    await page.getByRole('button', { name: 'Tekrar dene' }).click();
    await expect.poll(() => pending.length).toBe(2);
    await expect(page.getByTestId('async-section-loading')).toBeVisible();
    await pending[1].fulfill({ json: { interactions: [] } });
    await expect(page.getByText('Henüz etkileşim kaydı yok')).toBeVisible();
    await expect(page.getByText('Görüşmeleriniz gerçekleştikçe mentörün etkileşimleri buraya kaydedecek.')).toBeVisible();
    await expect(page.getByText('No interactions logged yet')).toHaveCount(0);
  } finally {
    await cleanupByEmail(email);
  }
});

test('mentor analytics retries a failed load and renders the returned stats', async ({ page }) => {
  const email = uniqueEmail('async-analytics');
  await seedUser(email, 'AsyncPass123!', 'MENTOR', 'Async Mentor');
  const pending: Route[] = [];

  try {
    await signInAndSettle(page, email, 'AsyncPass123!', '/mentor');
    await page.route('**/api/mentor/analytics', async (route) => { pending.push(route); });
    await page.goto('/mentor/analytics');

    await expect.poll(() => pending.length).toBe(1);
    await expect(page.getByTestId('async-section-loading')).toBeVisible();
    await pending[0].fulfill({ status: 500, json: { error: 'Failed' } });
    await expect(page.getByTestId('async-section-error')).toBeVisible();

    await page.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => pending.length).toBe(2);
    await expect(page.getByTestId('async-section-loading')).toBeVisible();
    await pending[1].fulfill({
      json: {
        funnel: {}, totalRelations: 3, activeRelations: 2, hired: 1,
        conversionToHired: 33, interactions: 7, goals: { open: 1, done: 2, total: 3 }, avgDaysToHired: 12,
      },
    });
    await expect(page.getByText('Total mentees')).toBeVisible();
    await expect(page.getByText('3', { exact: true }).first()).toBeVisible();
  } finally {
    await cleanupByEmail(email);
  }
});
