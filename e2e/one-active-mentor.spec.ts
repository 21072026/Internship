import { test, expect, type Page } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

/**
 * ONE MENTEE, AT MOST ONE ACTIVE MENTOR — EPIC F / #419.
 *
 * The invariant was always intended (POST /api/mentorship has answered 409 for
 * it since the beginning) but was enforced at two of eight write paths. These
 * specs cover the back doors that used to create a violation by accident, plus
 * the read-only report that says whether live data already holds one.
 *
 * Driven through the API on purpose: what is under test is what the SERVER
 * writes, and two of these paths (registration auto-link, relation reopen) have
 * no UI that reaches them.
 *
 * Only the first is @smoke — it is the back door that fires with nobody
 * pressing a button, it notifies the mentee, and it is a single POST. The
 * concurrency case is deliberately excluded from the gate: it is timing
 * sensitive and the PR gate must stay fast — and for the same reason it
 * asserts only the outcomes the shipped code guarantees, not the ones the
 * unique index will (see the comment in that test).
 */

const PASSWORD = 'OneMentor123!';

async function signIn(page: Page, email: string, landing: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(landing), { timeout: 20_000 });
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test(
  'an invitation naming a mentee who already has a mentor creates no second mentorship',
  { tag: '@smoke' },
  async ({ request }) => {
    const adminEmail = uniqueEmail('oam-admin');
    const mentorAEmail = uniqueEmail('oam-mentor-a');
    const inviteeEmail = uniqueEmail('oam-invitee-mentor');
    const menteeEmail = uniqueEmail('oam-mentee');

    const admin = await seedUser(adminEmail, PASSWORD, 'ADMIN', 'OAM Admin');
    const mentorA = await seedUser(mentorAEmail, PASSWORD, 'MENTOR', 'OAM Mentor A');
    const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'OAM Mentee');

    // The mentee is already live with mentor A.
    await prisma.mentorshipRelation.create({
      data: { mentorId: mentorA.id, menteeId: mentee.id, orgId: mentee.orgId, status: 'ACTIVE' },
    });

    // An admin invites a NEW MENTOR and pre-links that same mentee. Before the
    // fix, clicking through this link created a SECOND ACTIVE relation and told
    // the mentee they were now connected.
    const token = crypto.randomBytes(32).toString('hex');
    await prisma.invitationToken.create({
      data: {
        token,
        email: inviteeEmail,
        role: 'MENTOR',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        invitedById: admin.id,
        menteeId: mentee.id,
      },
    });

    try {
      // Registration itself must still succeed — the account is valid; only the
      // LINK is refused.
      const res = await request.post('/api/register', {
        data: { token, email: inviteeEmail, password: PASSWORD, fullName: 'OAM Invited Mentor', consent: true },
      });
      expect(res.status()).toBe(201);

      const invitee = await prisma.user.findUnique({ where: { email: inviteeEmail } });
      expect(invitee).toBeTruthy();

      const active = await prisma.mentorshipRelation.findMany({
        where: { menteeId: mentee.id, status: 'ACTIVE' },
      });
      expect(active).toHaveLength(1);
      expect(active[0].mentorId).toBe(mentorA.id);
      expect(
        await prisma.mentorshipRelation.count({ where: { mentorId: invitee!.id } })
      ).toBe(0);

      // The silent notification is half the bug: the mentee must not be told
      // they were connected to somebody they were not connected to.
      expect(
        await prisma.notification.count({ where: { userId: mentee.id, type: 'mentorship.connected' } })
      ).toBe(0);
      // The admin is told instead, and it is auditable.
      expect(
        await prisma.notification.count({ where: { userId: admin.id, type: 'mentorship.autoLinkSkipped' } })
      ).toBe(1);
      expect(
        await prisma.activityLog.count({ where: { action: 'mentorship.autolink_skipped', targetId: mentee.id } })
      ).toBe(1);
    } finally {
      await prisma.activityLog.deleteMany({ where: { action: 'mentorship.autolink_skipped', targetId: mentee.id } });
      await prisma.mentorshipRelation.deleteMany({ where: { menteeId: mentee.id } });
      await cleanupByEmail(inviteeEmail);
      await cleanupByEmail(menteeEmail);
      await cleanupByEmail(mentorAEmail);
      await cleanupByEmail(adminEmail);
    }
  }
);

test('inviting a mentor pre-linked to an already-mentored mentee is refused at invite time', async ({ page }) => {
  const adminEmail = uniqueEmail('oam-inv-admin');
  const mentorEmail = uniqueEmail('oam-inv-mentor');
  const menteeEmail = uniqueEmail('oam-inv-mentee');
  await seedUser(adminEmail, PASSWORD, 'ADMIN', 'OAM Invite Admin');
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'OAM Invite Mentor');
  const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'OAM Invite Mentee');
  await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, orgId: mentee.orgId, status: 'ACTIVE' },
  });

  try {
    await signIn(page, adminEmail, '/admin');

    // Refused while the admin is still looking at the form — not silently,
    // days later, in a click they never see.
    const res = await page.request.post('/api/invite', {
      data: { email: uniqueEmail('oam-inv-target'), role: 'MENTOR', menteeId: mentee.id },
    });
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('already_mentored');
    expect(await prisma.invitationToken.count({ where: { menteeId: mentee.id } })).toBe(0);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { menteeId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('reopening a completed mentorship is refused while another one is active', async ({ page }) => {
  const adminEmail = uniqueEmail('oam-reopen-admin');
  const mentorAEmail = uniqueEmail('oam-reopen-a');
  const mentorBEmail = uniqueEmail('oam-reopen-b');
  const menteeEmail = uniqueEmail('oam-reopen-mentee');
  await seedUser(adminEmail, PASSWORD, 'ADMIN', 'OAM Reopen Admin');
  const mentorA = await seedUser(mentorAEmail, PASSWORD, 'MENTOR', 'OAM Reopen A');
  const mentorB = await seedUser(mentorBEmail, PASSWORD, 'MENTOR', 'OAM Reopen B');
  const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'OAM Reopen Mentee');

  const completedAt = new Date();
  const relA = await prisma.mentorshipRelation.create({
    data: {
      mentorId: mentorA.id,
      menteeId: mentee.id,
      orgId: mentee.orgId,
      status: 'COMPLETED',
      completedAt,
    },
  });
  await prisma.mentorshipRelation.create({
    data: { mentorId: mentorB.id, menteeId: mentee.id, orgId: mentee.orgId, status: 'ACTIVE' },
  });

  try {
    await signIn(page, adminEmail, '/admin');

    const res = await page.request.put(`/api/mentorship/${relA.id}`, { data: { status: 'ACTIVE' } });
    expect(res.status()).toBe(409);
    expect((await res.json()).code).toBe('already_mentored');

    // Untouched: still COMPLETED, and completedAt was not cleared (which would
    // silently reopen the post-mentorship document window, #854).
    const after = await prisma.mentorshipRelation.findUnique({ where: { id: relA.id } });
    expect(after?.status).toBe('COMPLETED');
    expect(after?.completedAt).not.toBeNull();
    expect(await prisma.mentorshipRelation.count({ where: { menteeId: mentee.id, status: 'ACTIVE' } })).toBe(1);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { menteeId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorAEmail);
    await cleanupByEmail(mentorBEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('two simultaneous assignments are each answered 201 or 409, and the rows match the answers', async ({ page }) => {
  const adminEmail = uniqueEmail('oam-race-admin');
  const mentorAEmail = uniqueEmail('oam-race-a');
  const mentorBEmail = uniqueEmail('oam-race-b');
  const menteeEmail = uniqueEmail('oam-race-mentee');
  await seedUser(adminEmail, PASSWORD, 'ADMIN', 'OAM Race Admin');
  const mentorA = await seedUser(mentorAEmail, PASSWORD, 'MENTOR', 'OAM Race A');
  const mentorB = await seedUser(mentorBEmail, PASSWORD, 'MENTOR', 'OAM Race B');
  const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'OAM Race Mentee');

  try {
    await signIn(page, adminEmail, '/admin');

    const [first, second] = await Promise.all([
      page.request.post('/api/mentorship', { data: { mentorId: mentorA.id, menteeId: mentee.id } }),
      page.request.post('/api/mentorship', { data: { mentorId: mentorB.id, menteeId: mentee.id } }),
    ]);
    const statuses = [first.status(), second.status()].sort();

    // What this case can honestly assert is NOT "one 201 and one 409".
    // docs/one-active-mentor.md ("What is *not* closed") says why: MySQL
    // InnoDB runs REPEATABLE READ, so the guard inside the transaction is a
    // consistent NON-LOCKING read — both transactions can see "no active
    // mentor", both insert and both commit, because the
    // @@unique([activeMenteeKey]) backstop is deliberately out of scope until
    // the live data is known clean. `toEqual([201, 409])` would encode an
    // expectation the shipped code does not provide: it would red the 4x/day
    // scheduled suite (and fire the Turkish alert mail) over documented
    // behaviour, and on a run that happened to serialise it would "pass" while
    // proving nothing — inviting a future reader to skip the index that
    // actually closes the race.
    //
    // What the transactions DO buy, and what is asserted here: every request
    // is answered with one of the two intended outcomes (no 500, no half-open
    // state), at least one assignment lands, and the rows on disk agree
    // exactly with the answers given — no relation behind a 409, no 201
    // without a row. Tighten this to toEqual([201, 409]) in the PR that adds
    // the unique index.
    const created = statuses.filter((s) => s === 201).length;
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
    expect(created).toBeGreaterThanOrEqual(1);
    expect(await prisma.mentorshipRelation.count({ where: { menteeId: mentee.id, status: 'ACTIVE' } })).toBe(
      created,
    );
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { menteeId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorAEmail);
    await cleanupByEmail(mentorBEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('the integrity report names a mentee with two active mentors and clears once one is closed', async ({ page }) => {
  const adminEmail = uniqueEmail('oam-report-admin');
  const mentorAEmail = uniqueEmail('oam-report-a');
  const mentorBEmail = uniqueEmail('oam-report-b');
  const menteeEmail = uniqueEmail('oam-report-mentee');
  await seedUser(adminEmail, PASSWORD, 'ADMIN', 'OAM Report Admin');
  const mentorA = await seedUser(mentorAEmail, PASSWORD, 'MENTOR', 'OAM Report A');
  const mentorB = await seedUser(mentorBEmail, PASSWORD, 'MENTOR', 'OAM Report B');
  const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'OAM Report Mentee');

  // Seeded straight through prisma, deliberately bypassing every guard — this
  // is the shape of the rows that already exist in the wild.
  await prisma.mentorshipRelation.create({
    data: { mentorId: mentorA.id, menteeId: mentee.id, orgId: mentee.orgId, status: 'ACTIVE' },
  });
  const relB = await prisma.mentorshipRelation.create({
    data: { mentorId: mentorB.id, menteeId: mentee.id, orgId: mentee.orgId, status: 'ACTIVE' },
  });

  try {
    await signIn(page, adminEmail, '/admin');

    const res = await page.request.get('/api/admin/relation-integrity');
    expect(res.ok()).toBeTruthy();
    const report = await res.json();
    // Asserted per-mentee, never "the report is empty": the report is global and
    // another spec's residue can legitimately make it non-empty.
    expect(report.clean).toBe(false);
    const group = report.groups.find((g: { menteeId: string }) => g.menteeId === mentee.id);
    expect(group).toBeTruthy();
    expect(group.relations.map((r: { mentorId: string }) => r.mentorId).sort()).toEqual(
      [mentorA.id, mentorB.id].sort()
    );

    // Closing one — the intended human remediation — clears this mentee from it.
    await prisma.mentorshipRelation.update({
      where: { id: relB.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
    const after = await (await page.request.get('/api/admin/relation-integrity')).json();
    expect(after.groups.find((g: { menteeId: string }) => g.menteeId === mentee.id)).toBeUndefined();
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { menteeId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorAEmail);
    await cleanupByEmail(mentorBEmail);
    await cleanupByEmail(adminEmail);
  }
});
