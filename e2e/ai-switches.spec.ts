import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #2032: the organisation's AI switches. The first test is the boundary (hence
// @smoke): the kill switch and a per-task switch are enforced inside runAiGated
// — a switched-off task answers `disabled`, never `quota_exceeded`, never a
// paywall — a per-task allowance is measured against that task alone, the
// policy route is ADMIN-only and org-scoped (org B's admin neither sees nor
// changes org A's rows), and nothing is metered on a refusal. The second drives
// the console: the confirmed master switch, a task switch, a quota override.

const PASSWORD = 'Switch1234!';
const NEVER = /upgrade|yükselt|upgraden|feature_locked|AI_PACKAGE|quota/i;

async function seedOrg(prefix: string) {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `AI switches ${prefix}`, slug: `aiswitch-${stamp}` } });
  const adminEmail = uniqueEmail(`${prefix}-admin`);
  const menteeEmail = uniqueEmail(`${prefix}-mentee`);
  const admin = await seedUser(adminEmail, PASSWORD, 'ADMIN', 'Switch Admin');
  const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'Switch Mentee');
  for (const u of [admin, mentee]) await prisma.user.update({ where: { id: u.id }, data: { orgId: org.id, targetPosition: 'Backend Developer' } });
  const cleanup = async () => {
    await prisma.aiFeatureSetting.deleteMany({ where: { orgId: org.id } });
    await prisma.practiceSession.deleteMany({ where: { userId: mentee.id } }).catch(() => {});
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
    await prisma.setting.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  };
  return { org, adminEmail, menteeEmail, admin, mentee, cleanup };
}

type Policy = { enabled: boolean; tasks: { id: string; enabled: boolean; monthlyQuota: number | null }[] };

test(
  'the kill switch and a per-task switch refuse inside the gate as "disabled", a per-task allowance counts that task alone, and the policy is one org\'s own',
  { tag: '@smoke' },
  async ({ playwright }) => {
    const a = await seedOrg('ai-switch-a');
    const b = await seedOrg('ai-switch-b');
    const asAdminA = await playwright.request.newContext();
    const asMenteeA = await playwright.request.newContext();
    const asAdminB = await playwright.request.newContext();
    try {
      expect((await signInViaApi(asAdminA, a.adminEmail, PASSWORD)).ok).toBeTruthy();
      expect((await signInViaApi(asMenteeA, a.menteeEmail, PASSWORD)).ok).toBeTruthy();
      expect((await signInViaApi(asAdminB, b.adminEmail, PASSWORD)).ok).toBeTruthy();
      const usageBefore = await prisma.aiUsage.count();
      const prep = () => asMenteeA.post('/api/interview-prep', { data: { position: 'Backend Developer' } });
      const practice = () => asMenteeA.post('/api/interview-prep/session', { data: { position: 'Backend Developer' } });

      // Nothing configured: everything on, every task inherits, and CI's missing key is the only refusal.
      const initial = (await (await asAdminA.get('/api/admin/ai/policy')).json()) as Policy;
      expect(initial.enabled).toBe(true);
      expect(initial.tasks.some((t) => t.id === 'interview_prep')).toBeTruthy();
      expect(initial.tasks.every((t) => t.enabled && t.monthlyQuota === null)).toBeTruthy();
      expect((await prep()).status()).toBe(501);

      // The kill switch: every task answers "disabled" — not a quota, not a lock — and the status card says so.
      const off = await asAdminA.put('/api/admin/ai/policy', { data: { enabled: false } });
      expect(off.status()).toBe(200);
      expect(((await off.json()) as Policy).enabled).toBe(false);
      const refused = await prep();
      expect(refused.status()).toBe(403);
      const refusedBody = await refused.json();
      expect(refusedBody.code).toBe('disabled');
      expect(JSON.stringify(refusedBody)).not.toMatch(NEVER);
      expect(((await (await asMenteeA.post('/api/interview-prep/session', { data: { position: 'Backend Developer' } })).json()) as { code: string }).code).toBe('disabled');
      expect(((await (await asAdminA.get('/api/admin/ai/status')).json()) as { enabled: boolean }).enabled).toBe(false);

      // One task off, the rest on: interview prep is disabled while the practice interview still reaches the provider check.
      await asAdminA.put('/api/admin/ai/policy', { data: { enabled: true, tasks: [{ id: 'interview_prep', enabled: false }] } });
      expect(((await (await prep()).json()) as { code: string }).code).toBe('disabled');
      expect((await practice()).status()).toBe(501);

      // A per-task allowance of 0 spends that task alone: a quota refusal for it, the org quota untouched for the rest.
      const quota = await asAdminA.put('/api/admin/ai/policy', { data: { tasks: [{ id: 'interview_prep', enabled: true, monthlyQuota: 0 }] } });
      expect(quota.status()).toBe(200);
      expect(((await quota.json()) as Policy).tasks.find((t) => t.id === 'interview_prep')).toMatchObject({ enabled: true, monthlyQuota: 0 });
      const spent = await prep();
      expect(spent.status()).toBe(429);
      expect(((await spent.json()) as { code: string }).code).toBe('quota_exceeded');
      expect((await practice()).status()).toBe(501);
      // Clearing the override puts the task back on the org quota.
      await asAdminA.put('/api/admin/ai/policy', { data: { tasks: [{ id: 'interview_prep', monthlyQuota: null }] } });
      expect((await prep()).status()).toBe(501);

      // The shape is bounded: unknown task, bad quota, unknown field.
      expect((await asAdminA.put('/api/admin/ai/policy', { data: { tasks: [{ id: 'nope', enabled: false }] } })).status()).toBe(400);
      expect((await asAdminA.put('/api/admin/ai/policy', { data: { tasks: [{ id: 'interview_prep', monthlyQuota: -1 }] } })).status()).toBe(400);
      expect((await asAdminA.put('/api/admin/ai/policy', { data: { enabled: false, extra: 1 } })).status()).toBe(400);
      // Admin only.
      expect((await asMenteeA.get('/api/admin/ai/policy')).status()).toBe(403);
      expect((await asMenteeA.put('/api/admin/ai/policy', { data: { enabled: false } })).status()).toBe(403);
      expect((await playwright.request.newContext().then((c) => c.get('/api/admin/ai/policy'))).status()).toBe(401);

      // Another organisation neither sees A's rows nor changes them: B's admin reads defaults, and B's kill switch leaves A on.
      await asAdminA.put('/api/admin/ai/policy', { data: { tasks: [{ id: 'interview_prep', enabled: false }] } });
      const seenByB = (await (await asAdminB.get('/api/admin/ai/policy')).json()) as Policy;
      expect(seenByB.enabled).toBe(true);
      expect(seenByB.tasks.find((t) => t.id === 'interview_prep')).toMatchObject({ enabled: true, monthlyQuota: null });
      await asAdminB.put('/api/admin/ai/policy', { data: { enabled: false } });
      const aAfterB = (await (await asAdminA.get('/api/admin/ai/policy')).json()) as Policy;
      expect(aAfterB.enabled).toBe(true);
      expect(aAfterB.tasks.find((t) => t.id === 'interview_prep')?.enabled).toBe(false);
      expect(await prisma.aiFeatureSetting.count({ where: { orgId: b.org.id } })).toBe(0);

      // Nothing was metered by any refusal.
      expect(await prisma.aiUsage.count()).toBe(usageBefore);
    } finally {
      await asAdminA.dispose();
      await asMenteeA.dispose();
      await asAdminB.dispose();
      await a.cleanup();
      await b.cleanup();
    }
  }
);

test('the console: the master switch asks first, a task switch and a quota override save, and the state survives a reload', async ({ page }) => {
  const a = await seedOrg('ai-switch-ui');
  try {
    await signInAndSettle(page, a.adminEmail, PASSWORD, '/admin');
    await gotoSettled(page, '/admin/ai');
    const card = page.getByTestId('ai-console-switches');
    await expect(card).toBeVisible({ timeout: 15_000 });
    const master = page.getByTestId('ai-console-master');
    await expect(master).toBeChecked();

    // Off needs a confirmation; cancelling changes nothing.
    await master.click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-dialog-cancel').click();
    await expect(master).toBeChecked();
    await master.click();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(master).not.toBeChecked({ timeout: 10_000 });
    await expect(page.getByTestId('ai-console-disabled')).toBeVisible();
    await expect(page.getByTestId('ai-console-switches-msg')).toContainText('Saved');

    // Back on, then one task off and a quota override on another.
    await master.click();
    await expect(master).toBeChecked({ timeout: 10_000 });
    await expect(page.getByTestId('ai-console-disabled')).toHaveCount(0);
    const prepSwitch = page.getByTestId('ai-switch-interview_prep');
    await prepSwitch.click();
    await expect(prepSwitch).not.toBeChecked({ timeout: 10_000 });
    await expect(page.getByTestId('ai-switch-row-interview_prep')).toContainText('off');
    await page.getByTestId('ai-quota-cv_feedback').fill('5');
    await page.getByTestId('ai-quota-save-cv_feedback').click();
    await expect(page.getByTestId('ai-console-switches-msg')).toContainText('Saved', { timeout: 10_000 });
    await expect(page.locator('body')).not.toContainText(/upgrade/i);

    await page.reload();
    await expect(page.getByTestId('ai-console-master')).toBeChecked({ timeout: 15_000 });
    await expect(page.getByTestId('ai-switch-interview_prep')).not.toBeChecked();
    await expect(page.getByTestId('ai-quota-cv_feedback')).toHaveValue('5');
    const rows = await prisma.aiFeatureSetting.findMany({ where: { orgId: a.org.id }, orderBy: { taskId: 'asc' } });
    expect(rows.map((r) => [r.taskId, r.enabled, r.monthlyQuota])).toEqual([['cv_feedback', true, 5], ['interview_prep', false, null]]);
  } finally {
    await a.cleanup();
  }
});
