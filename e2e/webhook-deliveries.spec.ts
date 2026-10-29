import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, setOrgFeature } from './helpers/db';
import { signInViaApi } from './helpers/auth';
import { webhookDeliveryId } from '@/lib/webhookDeliveryRule';

// The webhook delivery log and its replay (#1695). The attempt/retry/disable
// machinery is pinned against the real worker in webhook-delivery.unit.spec.ts
// (an HTTPS receiver on a public address is impractical in e2e); this spec
// pins the admin surface: a recorded FAILED delivery is listed and replayable,
// replay is authorized in the route (a MENTOR gets 403), another tenant's
// delivery is 404, an auto-disabled hook refuses a replay until it is
// re-enabled — and the re-enable clears the disable stamp.

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function orgWithAdmin(tag: string) {
  const stamp = `${Date.now()}-${Math.round(performance.now())}-${tag}`;
  const org = await prisma.organization.create({ data: { name: `WD ${tag} ${stamp}`, slug: `wd-${stamp}` } });
  const email = uniqueEmail(`wd-${tag}`);
  const admin = await seedUser(email, 'WdPass123', 'ADMIN', `${tag} Admin`);
  await prisma.user.update({ where: { id: admin.id }, data: { orgId: org.id } });
  // Re-enabling a hook is setting up an integration (#1744).
  await setOrgFeature(org.id, 'INTEGRATIONS_API', true);
  return { org, email };
}

async function failedDelivery(orgId: string) {
  const hook = await prisma.webhook.create({
    data: { url: 'https://receiver.example/hook', secret: 's', events: ['mentorship.created'], orgId },
  });
  const event = await prisma.domainEvent.create({
    data: { orgId, name: 'mentorship.created', version: 1, payload: { relationId: 'r1', mentorId: 'm1', menteeId: 'e1', companyId: null } },
  });
  const delivery = await prisma.webhookDelivery.create({
    data: {
      orgId, webhookId: hook.id, eventId: event.id, eventName: event.name,
      deliveryId: webhookDeliveryId(event.id, hook.id), attempt: 1, status: 'DEAD', responseCode: 500, responseBody: 'boom', durationMs: 40,
    },
  });
  return { hook, event, delivery };
}

test('an admin lists a failed delivery and replays it; a mentor and another tenant cannot', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const a = await orgWithAdmin('A');
  const b = await orgWithAdmin('B');
  const mentorEmail = uniqueEmail('wd-mentor');
  const mentor = await seedUser(mentorEmail, 'WdPass123', 'MENTOR', 'WD Mentor');
  await prisma.user.update({ where: { id: mentor.id }, data: { orgId: a.org.id } });
  const fa = await failedDelivery(a.org.id);
  const fb = await failedDelivery(b.org.id);
  const adminCtx = await playwright.request.newContext({ baseURL });
  const mentorCtx = await playwright.request.newContext({ baseURL });
  try {
    expect((await signInViaApi(adminCtx, a.email, 'WdPass123')).ok).toBe(true);
    expect((await signInViaApi(mentorCtx, mentorEmail, 'WdPass123')).ok).toBe(true);

    // Listed for its own hook, with what the attempt recorded.
    const list = await (await adminCtx.get(`/api/admin/webhooks/deliveries?webhookId=${fa.hook.id}`)).json();
    expect(list.deliveries).toHaveLength(1);
    expect(list.deliveries[0]).toMatchObject({ id: fa.delivery.id, status: 'DEAD', responseCode: 500, eventName: 'mentorship.created' });
    // Another tenant's hook reads as empty.
    const other = await (await adminCtx.get(`/api/admin/webhooks/deliveries?webhookId=${fb.hook.id}`)).json();
    expect(other.deliveries).toHaveLength(0);

    // Replay: authorized in the route.
    expect((await mentorCtx.post(`/api/admin/webhooks/deliveries/${fa.delivery.id}/replay`)).status()).toBe(403);
    expect((await mentorCtx.get(`/api/admin/webhooks/deliveries?webhookId=${fa.hook.id}`)).status()).toBe(403);
    expect((await mentorCtx.post(`/api/admin/webhooks/replay-events?id=${fa.hook.id}`, { data: { count: 5 } })).status()).toBe(403);
    expect((await adminCtx.post(`/api/admin/webhooks/deliveries/${fb.delivery.id}/replay`)).status()).toBe(404);

    const before = await prisma.job.count({ where: { name: 'webhook.deliver', orgId: a.org.id } });
    const replay = await adminCtx.post(`/api/admin/webhooks/deliveries/${fa.delivery.id}/replay`);
    expect(replay.status()).toBe(202);
    const jobs = await prisma.job.findMany({ where: { name: 'webhook.deliver', orgId: a.org.id } });
    expect(jobs.length).toBe(before + 1);
    expect(jobs.at(-1)!.payload).toEqual({ eventId: fa.event.id, webhookId: fa.hook.id });

    // Replay the last N events, from the DomainEvent record.
    const last = await adminCtx.post(`/api/admin/webhooks/replay-events?id=${fa.hook.id}`, { data: { count: 5 } });
    expect(last.status()).toBe(202);
    expect((await last.json()).queued).toBe(1);
    expect((await adminCtx.post(`/api/admin/webhooks/replay-events?id=${fa.hook.id}`, { data: { count: 0 } })).status()).toBe(400);

    // An auto-disabled hook refuses a replay; the explicit re-enable clears the stamp.
    await prisma.webhook.update({ where: { id: fa.hook.id }, data: { disabledAt: new Date(), disabledReason: '20 consecutive failed deliveries', consecutiveFailures: 20 } });
    expect((await adminCtx.post(`/api/admin/webhooks/deliveries/${fa.delivery.id}/replay`)).status()).toBe(409);
    const hooks = await (await adminCtx.get('/api/admin/webhooks')).json();
    expect(hooks.webhooks.find((h: { id: string }) => h.id === fa.hook.id)).toMatchObject({ disabledReason: '20 consecutive failed deliveries' });
    const reenable = await adminCtx.patch(`/api/admin/webhooks?id=${fa.hook.id}`, { data: { active: true } });
    expect(reenable.status()).toBe(200);
    const row = await prisma.webhook.findUnique({ where: { id: fa.hook.id } });
    expect(row).toMatchObject({ disabledAt: null, disabledReason: null, consecutiveFailures: 0 });
    expect((await adminCtx.post(`/api/admin/webhooks/deliveries/${fa.delivery.id}/replay`)).status()).toBe(202);
  } finally {
    await adminCtx.dispose();
    await mentorCtx.dispose();
    await prisma.job.deleteMany({ where: { name: 'webhook.deliver', orgId: { in: [a.org.id, b.org.id] } } }).catch(() => {});
    for (const f of [fa, fb]) {
      await prisma.webhook.deleteMany({ where: { id: f.hook.id } }).catch(() => {});
      await prisma.domainEvent.deleteMany({ where: { id: f.event.id } }).catch(() => {});
    }
    await cleanupByEmail(mentorEmail);
    for (const x of [a, b]) {
      await cleanupByEmail(x.email);
      await prisma.organization.delete({ where: { id: x.org.id } }).catch(() => {});
    }
  }
});
