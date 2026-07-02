import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('invitations persist, can be resent and cancelled', async ({ page }) => {
  const adminEmail = uniqueEmail('inv-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Inv Admin');
  const inviteeEmail = uniqueEmail('inv-target');
  let inviteId = '';

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Send an invitation.
    const sent = await page.request.post('/api/invite', { data: { email: inviteeEmail, role: 'MENTOR' } });
    expect(sent.status()).toBe(201);
    inviteId = (await sent.json()).invitationId;

    // It persists in the list (survives refresh — it's server-backed).
    const list1 = await (await page.request.get('/api/invite')).json();
    expect(list1.invitations.some((i: { id: string }) => i.id === inviteId)).toBeTruthy();

    // Resend works and keeps the invite valid.
    const resend = await page.request.post(`/api/invite/${inviteId}`);
    expect(resend.ok()).toBeTruthy();
    expect((await resend.json()).registerUrl).toContain('/auth/register?token=');

    // Cancel removes it.
    const del = await page.request.delete(`/api/invite/${inviteId}`);
    expect(del.ok()).toBeTruthy();
    const list2 = await (await page.request.get('/api/invite')).json();
    expect(list2.invitations.some((i: { id: string }) => i.id === inviteId)).toBeFalsy();
    inviteId = '';
  } finally {
    if (inviteId) await prisma.invitationToken.deleteMany({ where: { id: inviteId } });
    await prisma.invitationToken.deleteMany({ where: { email: inviteeEmail } });
    await cleanupByEmail(adminEmail);
  }
});
