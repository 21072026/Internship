import { test, expect, type APIRequestContext } from '@playwright/test';
import crypto from 'node:crypto';
import { cleanupByEmail, prisma, seedUser, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAsFreshUser, signInViaApi } from './helpers/auth';
import { getSetting } from '../src/lib/settings';
import { currentPeriod, periodRange, previousPeriod } from '../src/lib/meteringRules';

// /admin/ai (#2030). A fresh organisation, so the figures are exactly what this
// spec metered — the console is scoped to the admin's org, the same org the
// quota counts. CI has no provider key, so the status card says so.

const PASSWORD = 'AiConsole123!';
let orgId = '';
const emails = { admin: '', mentor: '', mentee: '' };
const ctx: Record<string, APIRequestContext> = {};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }, info) => {
  const org = await prisma.organization.create({ data: { name: 'AI Console Org', slug: `aiconsole-${Date.now()}-${crypto.randomBytes(3).toString('hex')}` } });
  orgId = org.id;
  for (const role of ['admin', 'mentor', 'mentee'] as const) {
    emails[role] = uniqueEmail(`aiconsole-${role}`);
    const u = await seedUser(emails[role], PASSWORD, role.toUpperCase() as 'ADMIN' | 'MENTOR' | 'MENTEE', `AI Console ${role}`);
    await prisma.user.update({ where: { id: u.id }, data: { orgId } });
  }
  // This month: cv_feedback — 3 answered, 1 unreadable, 2 provider failures, one flagged by the tripwire.
  const { gte } = periodRange(currentPeriod());
  const at = (h: number) => new Date(Math.min(Date.now() - 1000, gte.getTime() + h * 3600_000));
  const ok = (latencyMs: number, h: number, flags: string | null = null) => ({
    scope: 'cv_feedback', taskId: 'cv_feedback', orgId, outcome: 'ok', model: 'claude-opus-4-8', inputTokens: 1000, outputTokens: 200, costMicros: 40_000, latencyMs, flags, createdAt: at(h),
  });
  await prisma.aiUsage.createMany({
    data: [
      ok(100, 1), ok(200, 2), ok(300, 3, 'instruction_override,prompt_exfiltration'),
      { scope: 'cv_feedback', taskId: 'cv_feedback', orgId, outcome: 'parse_error', model: 'claude-opus-4-8', inputTokens: 900, outputTokens: 5, costMicros: 10_000, latencyMs: 400, createdAt: at(4) },
      { scope: 'cv_feedback', taskId: 'cv_feedback', orgId, outcome: 'provider_error', model: 'claude-opus-4-8', createdAt: at(5) },
      { scope: 'cv_feedback', taskId: 'cv_feedback', orgId, outcome: 'provider_error', model: 'claude-opus-4-8', createdAt: at(6) },
      // Last month: one interview prep call.
      { scope: 'interview_prep', taskId: 'interview_prep', orgId, outcome: 'ok', model: 'claude-opus-4-8', inputTokens: 50, outputTokens: 500, costMicros: 20_000, latencyMs: 900, createdAt: new Date(periodRange(previousPeriod(currentPeriod())).gte.getTime() + 3600_000) },
    ],
  });
  const baseURL = info.project.use.baseURL;
  for (const role of ['admin', 'mentor', 'mentee', 'anon'] as const) {
    ctx[role] = await playwright.request.newContext({ baseURL });
    if (role !== 'anon') expect((await signInViaApi(ctx[role], emails[role], PASSWORD)).ok).toBe(true);
  }
});

test.afterAll(async () => {
  await Promise.all(Object.values(ctx).map((c) => c.dispose()));
  await prisma.aiUsage.deleteMany({ where: { orgId } });
  await prisma.setting.deleteMany({ where: { orgId } });
  for (const e of Object.values(emails)) if (e) await cleanupByEmail(e);
  if (orgId) await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
});

test('only an admin may read the console — refused at the route, not by hiding the link', async () => {
  for (const path of ['/api/admin/ai/usage', '/api/admin/ai/status', '/api/admin/ai/usage?format=csv']) {
    expect((await ctx.anon.get(path)).status(), path).toBe(401);
    expect((await ctx.mentor.get(path)).status(), path).toBe(403);
    expect((await ctx.mentee.get(path)).status(), path).toBe(403);
  }
  expect((await ctx.admin.get('/api/admin/ai/usage?month=2026-13')).status()).toBe(400);
});

test('usage is broken down by task and outcome for this month and the last, status and CSV agree', async () => {
  const res = await ctx.admin.get('/api/admin/ai/usage');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.current.tasks).toHaveLength(1);
  expect(body.current.tasks[0]).toMatchObject({
    task: 'cv_feedback', calls: 6, ok: 3, parseErrors: 1, providerErrors: 2, inputTokens: 3900, outputTokens: 605, costMicros: 130_000, unpricedCalls: 0, p50LatencyMs: 200, p95LatencyMs: 400,
  });
  expect(body.previous.tasks).toEqual([expect.objectContaining({ task: 'interview_prep', calls: 1, ok: 1 })]);
  // Provider failures never consume quota (#2024): 3 answered + 1 unreadable.
  expect(body.quota.used).toBe(4);

  const status = await (await ctx.admin.get('/api/admin/ai/status')).json();
  expect(status).toMatchObject({ configured: false, breaker: 'closed', flaggedCalls: 1, flagWindowDays: 30 });
  expect(status.tasks.find((t: { id: string }) => t.id === 'cv_feedback')).toMatchObject({ audience: 'participant' });
  expect(JSON.stringify(status)).not.toMatch(/sk-ant|ANTHROPIC_API_KEY/);

  const csv = await ctx.admin.get('/api/admin/ai/usage?format=csv');
  expect(csv.headers()['content-type']).toContain('text/csv');
  const lines = (await csv.text()).trim().split('\n');
  expect(lines[0]).toContain('"createdAt","task","outcome"');
  expect(lines).toHaveLength(7);
  expect(lines.filter((l) => l.includes('"provider_error"'))).toHaveLength(2);
});

test('an admin reads spend and failures per task and changes the monthly quota from the screen', { tag: '@smoke' }, async ({ page }) => {
  await signInAsFreshUser(page, emails.admin, PASSWORD, '/admin');
  await gotoSettled(page, '/admin/ai');
  const v = (id: string) => page.locator(`[data-testid="${id}"]:visible`);
  await expect(v('ai-usage-current-calls-cv_feedback')).toHaveText('6');
  await expect(v('ai-usage-current-parse-cv_feedback')).toHaveText('1');
  await expect(v('ai-usage-current-provider-cv_feedback')).toHaveText('2');
  await expect(v('ai-usage-current-spend-cv_feedback')).toHaveText('$0.13');
  await expect(v('ai-usage-previous-calls-interview_prep')).toHaveText('1');
  await expect(v('ai-console-configured')).toContainText('No provider key');
  await expect(v('ai-console-flagged')).toContainText('1 call(s) flagged');

  await expect(async () => {
    await v('ai-console-quota-input').fill('7');
    await v('ai-console-quota-save').click();
    await expect(v('ai-console-quota-msg')).toContainText('Quota saved', { timeout: 3_000 });
  }).toPass({ timeout: 15_000 });
  await expect(v('ai-console-quota-used')).toHaveText('4 of 7 calls used this month');
  expect(await getSetting('aiMonthlyQuota', orgId)).toBe('7');

  await v('ai-console-quota-input').fill('0');
  await v('ai-console-quota-save').click();
  await expect(v('ai-console-quota-off')).toBeVisible();
});
