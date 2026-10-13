import { test, expect, type APIRequestContext } from '@playwright/test';
import { cleanupByEmail, cleanupCustomPipelineOrg, prisma, seedCustomPipelineOrg, seedUser, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAsFreshUser, signInViaApi } from './helpers/auth';
// Static imports: Playwright resolves the `@/…` alias in the spec's import graph.
import { listRetentionEntries, runRetention } from '../src/lib/retentionPrune';
import '../src/lib/retentionEntries';

// Safeguarding (#2056): detect → flag → review, and the message-retention mask.
//
// Everything runs inside a throwaway org, so its watch list and retention
// window touch nobody else's messages. The two product rules are asserted, not
// assumed: a flagged message is still DELIVERED (stored, unchanged, visible to
// the recipient), and the queue is ADMIN-only and tenant-scoped at the route.

const PW = 'Safeguard123!';
let seeded: Awaited<ReturnType<typeof seedCustomPipelineOrg>>;
let mentorId = '';
let menteeId = '';
let menteeEmail = '';
let admin: APIRequestContext;
let mentor: APIRequestContext;
let mentee: APIRequestContext;
let otherAdmin: APIRequestContext;
const otherAdminEmail = uniqueEmail('safeguard-other-admin');
let contactFlagId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }, info) => {
  seeded = await seedCustomPipelineOrg('safeguard', PW);
  const users = await prisma.user.findMany({ where: { orgId: seeded.org.id }, select: { id: true, role: true, email: true } });
  mentorId = users.find((u) => u.role === 'MENTOR')!.id;
  const menteeRow = users.find((u) => u.role === 'MENTEE')!;
  menteeId = menteeRow.id;
  menteeEmail = menteeRow.email;
  const mentorEmail = users.find((u) => u.role === 'MENTOR')!.email;
  // An admin of ANOTHER tenant (the default org) — must never see this org's queue.
  await seedUser(otherAdminEmail, PW, 'ADMIN', 'Safeguard Other Admin');

  const baseURL = info.project.use.baseURL;
  [admin, mentor, mentee, otherAdmin] = await Promise.all([1, 2, 3, 4].map(() => playwright.request.newContext({ baseURL })));
  expect((await signInViaApi(admin, seeded.adminEmail, PW)).ok).toBe(true);
  expect((await signInViaApi(mentor, mentorEmail, PW)).ok).toBe(true);
  expect((await signInViaApi(mentee, menteeEmail, PW)).ok).toBe(true);
  expect((await signInViaApi(otherAdmin, otherAdminEmail, PW)).ok).toBe(true);
});

test.afterAll(async () => {
  await Promise.all([admin, mentor, mentee, otherAdmin].map((c) => c?.dispose()));
  if (seeded) {
    await prisma.safeguardingFlag.deleteMany({ where: { orgId: seeded.org.id } });
    await prisma.message.deleteMany({ where: { relationId: seeded.relationId } });
    await prisma.setting.deleteMany({ where: { orgId: seeded.org.id } });
    await cleanupCustomPipelineOrg(seeded.org.id, seeded.emails);
  }
  await cleanupByEmail(otherAdminEmail);
});

async function post(ctx: APIRequestContext, body: string) {
  const res = await ctx.post('/api/messages', { data: { relationId: seeded.relationId, body } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).message.id as string;
}

test('the queue and its settings are ADMIN-only, checked at the route', async () => {
  for (const ctx of [mentor, mentee]) {
    expect((await ctx.get('/api/admin/safeguarding')).status()).toBe(403);
    expect((await ctx.put('/api/admin/safeguarding/settings', { data: { keywords: ['x'] } })).status()).toBe(403);
    expect((await ctx.patch('/api/admin/safeguarding/nope', { data: { outcome: 'REVIEWED' } })).status()).toBe(403);
  }
});

test('a shared phone number is flagged — and the message is still delivered, unchanged', async () => {
  const body = 'Text me privately, my number is 0176 12345678';
  const id = await post(mentee, body);

  // Delivered: stored as written, not held, and in the recipient's thread.
  const stored = await prisma.message.findUniqueOrThrow({ where: { id } });
  expect(stored.body).toBe(body);
  expect(stored.deletedForEveryoneAt).toBeNull();
  const thread = await (await mentor.get(`/api/messages?relationId=${seeded.relationId}`)).json();
  expect(thread.messages.map((m: { id: string }) => m.id)).toContain(id);

  const flags = await prisma.safeguardingFlag.findMany({ where: { messageId: id } });
  expect(flags).toHaveLength(1);
  expect(flags[0].kind).toBe('CONTACT_DETAIL');
  expect(flags[0].orgId).toBe(seeded.org.id);
  // The flag keeps a masked term, never the number itself.
  expect(flags[0].matchedTerm).not.toContain('12345678');
  contactFlagId = flags[0].id;

  // The org's admin is told — with no detail in the bell.
  const adminRow = await prisma.user.findFirstOrThrow({ where: { email: seeded.adminEmail } });
  const bell = await prisma.notification.findFirst({ where: { userId: adminRow.id, type: 'safeguarding.flagged' } });
  expect(bell?.link).toBe('/admin/safeguarding');
  expect(JSON.stringify(bell?.params ?? {})).not.toContain('0176');
});

test('a configured watch keyword is flagged; ordinary dates and prices are not', async () => {
  const put = await admin.put('/api/admin/safeguarding/settings', { data: { keywords: ['geheim', 'meet alone', 'geheim'] } });
  expect(put.status()).toBe(200);
  expect((await put.json()).keywords).toEqual(['geheim', 'meet alone']);

  const hit = await post(mentor, 'Lass das bitte GEHEIM bleiben.');
  const quiet = await post(mentor, 'Termin am 07.10.2026 um 14:30, Gehalt 3.500 € brutto.');

  const hitFlags = await prisma.safeguardingFlag.findMany({ where: { messageId: hit } });
  expect(hitFlags.map((f) => [f.kind, f.matchedTerm])).toEqual([['KEYWORD', 'geheim']]);
  expect(await prisma.safeguardingFlag.count({ where: { messageId: quiet } })).toBe(0);

  // An edit is re-scanned; the same term is not flagged twice.
  const edit = await mentor.patch(`/api/messages/${hit}`, { data: { body: 'Geheim, wirklich geheim.' } });
  expect(edit.ok()).toBe(true);
  expect(await prisma.safeguardingFlag.count({ where: { messageId: hit } })).toBe(1);
});

test('another tenant\'s admin can neither list nor review this org\'s flags', async () => {
  const theirs = await (await otherAdmin.get('/api/admin/safeguarding?status=all&pageSize=100')).json();
  expect(theirs.rows.map((r: { id: string }) => r.id)).not.toContain(contactFlagId);
  expect((await otherAdmin.patch(`/api/admin/safeguarding/${contactFlagId}`, { data: { outcome: 'NO_ACTION' } })).status()).toBe(404);
  expect((await prisma.safeguardingFlag.findUniqueOrThrow({ where: { id: contactFlagId } })).reviewedAt).toBeNull();
});

test('an admin reviews a flag from the queue', async ({ page }) => {
  await signInAsFreshUser(page, seeded.adminEmail, PW, '/admin');
  await gotoSettled(page, '/admin/safeguarding');
  const row = page.getByTestId(`safeguarding-flag-${contactFlagId}`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId('safeguarding-context')).toContainText('my number is');

  // The page's own search box — not AdminNav's sidebar filter.
  await page.getByTestId('safeguarding-search').fill('safeguard Mentee');
  await expect(row).toBeVisible();

  await row.getByTestId('safeguarding-reviewed').click();
  await expect(row).toHaveCount(0);
  await page.getByTestId('safeguarding-tab-reviewed').click();
  await expect(page.getByTestId(`safeguarding-flag-${contactFlagId}`).getByTestId('safeguarding-outcome')).toContainText('Reviewed');

  const flag = await prisma.safeguardingFlag.findUniqueOrThrow({ where: { id: contactFlagId } });
  expect(flag.outcome).toBe('REVIEWED');
  expect(flag.reviewedById).not.toBeNull();
  expect(await prisma.activityLog.count({ where: { action: 'safeguarding.reviewed', targetId: contactFlagId } })).toBe(1);
});

test('retention masks old message text in this org only, and keeps the rows', async () => {
  const day = 24 * 60 * 60 * 1000;
  const old = await prisma.message.create({
    data: {
      relationId: seeded.relationId,
      senderId: menteeId,
      body: 'An old message with a private detail',
      createdAt: new Date(Date.now() - 90 * day),
      attachments: { create: { filename: 'note.txt', contentType: 'text/plain', size: 3, data: Buffer.from('abc') } },
    },
  });
  const fresh = await prisma.message.create({ data: { relationId: seeded.relationId, senderId: mentorId, body: 'A message from today' } });
  // An equally old message from a DEFAULT-org user, whose org keeps forever.
  const outsider = await prisma.user.findFirstOrThrow({ where: { email: otherAdminEmail } });
  const outside = await prisma.message.create({
    data: { senderId: outsider.id, body: 'Default-org message', createdAt: new Date(Date.now() - 90 * day) },
  });

  // "3" is raised to the 30-day floor; still well inside 90 days.
  const put = await admin.put('/api/admin/safeguarding/settings', { data: { messageRetentionDays: 3 } });
  expect((await put.json()).messageRetentionDays).toBe(3);

  const entry = listRetentionEntries().find((e) => e.key === 'message');
  expect(entry).toBeTruthy();
  const result = await runRetention({ entries: [entry!] });
  expect(result.failed).toEqual([]);

  const masked = await prisma.message.findUniqueOrThrow({ where: { id: old.id }, include: { attachments: true } });
  expect(masked.body).toBe('');
  expect(masked.deletedForEveryoneAt).not.toBeNull();
  expect(masked.attachments).toHaveLength(0);
  expect((await prisma.message.findUniqueOrThrow({ where: { id: fresh.id } })).body).toBe('A message from today');
  expect((await prisma.message.findUniqueOrThrow({ where: { id: outside.id } })).body).toBe('Default-org message');

  // A second run finds nothing more to do in this org.
  const again = await runRetention({ entries: [entry!] });
  expect((await prisma.message.findUniqueOrThrow({ where: { id: old.id } })).deletedForEveryoneAt).toEqual(masked.deletedForEveryoneAt);
  expect(again.failed).toEqual([]);
  await prisma.message.delete({ where: { id: outside.id } });
});
