import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('scheduling a meeting without a link auto-generates a video room link', async ({ page }) => {
  const mentorEmail = uniqueEmail('aml-mentor');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'AML Mentor');
  const mentee = await seedUser(uniqueEmail('aml-mentee'), 'x', 'MENTEE', 'AML Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    const res = await page.request.post('/api/meetings', {
      data: { relationIds: [rel.id], title: 'Intro call', scheduledAt: '2026-09-01T10:00:00.000Z', meetLink: '' },
    });
    expect(res.ok()).toBeTruthy();

    const meeting = await prisma.meeting.findFirst({ where: { relationId: rel.id } });
    expect(meeting?.meetLink).toBeTruthy();
    expect(meeting?.meetLink).toContain('meet.jit.si');
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(mentee.email);
    await cleanupByEmail(mentorEmail);
  }
});

// #759 — a bulk-scheduled meeting is ONE shared meeting: every selected mentee
// must get the SAME auto-generated link (not a separate room each), while the
// per-person RSVP token stays unique.
test('bulk scheduling without a link shares one meeting link across all selected mentees', async ({ page }) => {
  const mentorEmail = uniqueEmail('bulk-mentor');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Bulk Mentor');
  const mentees = await Promise.all([
    seedUser(uniqueEmail('bulk-m1'), 'x', 'MENTEE', 'Bulk M1'),
    seedUser(uniqueEmail('bulk-m2'), 'x', 'MENTEE', 'Bulk M2'),
    seedUser(uniqueEmail('bulk-m3'), 'x', 'MENTEE', 'Bulk M3'),
  ]);
  const rels = await Promise.all(
    mentees.map((m) => prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: m.id } })),
  );
  const relIds = rels.map((r) => r.id);

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    const res = await page.request.post('/api/meetings', {
      data: { relationIds: relIds, title: 'Weekly', scheduledAt: '2026-09-01T10:00:00.000Z', meetLink: '' },
    });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).created).toBe(relIds.length);

    const meetings = await prisma.meeting.findMany({ where: { relationId: { in: relIds } } });
    expect(meetings).toHaveLength(relIds.length);

    // All share exactly one auto-generated link…
    const links = new Set(meetings.map((m) => m.meetLink));
    expect(links.size).toBe(1);
    expect([...links][0]).toContain('meet.jit.si');

    // …but each participant's RSVP token is unique.
    const tokens = new Set(meetings.map((m) => m.rsvpToken));
    expect(tokens.size).toBe(relIds.length);
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: { in: relIds } } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: relIds } } });
    await Promise.all(mentees.map((m) => cleanupByEmail(m.email)));
    await cleanupByEmail(mentorEmail);
  }
});

// ── Bring your own link (#2007) ──────────────────────────────────────────────
//
// Each test below gets an organization of its own: the policy is a column on
// the organizer's org, and the shared default org is what every other worker
// is scheduling against. API-only on purpose — the rule is server-side, and a
// browser adds nothing but time here.


type Policy = 'BUILTIN' | 'PREFER_PERSONAL' | 'REQUIRE_EXTERNAL';

async function seedOrgPair(prefix: string, policy: Policy, personalMeetingUrl: string | null) {
  const slug = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const org = await prisma.organization.create({ data: { name: `BYOL ${prefix}`, slug, conferencingPolicy: policy } });
  const mentorEmail = uniqueEmail(`${prefix}-mentor`);
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'BYOL Mentor', org.id);
  if (personalMeetingUrl) {
    await prisma.user.update({ where: { id: mentor.id }, data: { personalMeetingUrl } });
  }
  const mentee = await seedUser(uniqueEmail(`${prefix}-mentee`), 'x', 'MENTEE', 'BYOL Mentee', org.id);
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id, orgId: org.id } });
  const cleanup = async () => {
    await prisma.meeting.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(mentee.email);
    await cleanupByEmail(mentorEmail);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  };
  return { org, mentor, mentorEmail, mentee, rel, cleanup };
}

const PERSONAL = 'https://zoom.us/my/byol-mentor';

test('PREFER_PERSONAL: the organizer’s saved room is what the meeting gets when nothing is pasted', async ({ request }) => {
  const s = await seedOrgPair('byol-prefer', 'PREFER_PERSONAL', PERSONAL);
  try {
    expect((await signInViaApi(request, s.mentorEmail, 'MentorPass123')).ok).toBeTruthy();
    const res = await request.post('/api/meetings', {
      data: { relationIds: [s.rel.id], title: 'Weekly', scheduledAt: '2026-09-01T10:00:00.000Z', meetLink: '' },
    });
    expect(res.ok()).toBeTruthy();
    const meeting = await prisma.meeting.findFirst({ where: { relationId: s.rel.id } });
    expect(meeting?.meetLink).toBe(PERSONAL);
  } finally {
    await s.cleanup();
  }
});

test('BUILTIN: a saved personal room is ignored — today’s behaviour is unchanged', async ({ request }) => {
  const s = await seedOrgPair('byol-builtin', 'BUILTIN', PERSONAL);
  try {
    expect((await signInViaApi(request, s.mentorEmail, 'MentorPass123')).ok).toBeTruthy();
    const res = await request.post('/api/meetings', {
      data: { relationIds: [s.rel.id], title: 'Weekly', scheduledAt: '2026-09-01T10:00:00.000Z', meetLink: '' },
    });
    expect(res.ok()).toBeTruthy();
    const meeting = await prisma.meeting.findFirst({ where: { relationId: s.rel.id } });
    expect(meeting?.meetLink).toContain('meet.jit.si');
  } finally {
    await s.cleanup();
  }
});

test('REQUIRE_EXTERNAL: no link and no saved room is refused with a reason; a pasted link is stored as typed', async ({ request }) => {
  const s = await seedOrgPair('byol-require', 'REQUIRE_EXTERNAL', null);
  try {
    expect((await signInViaApi(request, s.mentorEmail, 'MentorPass123')).ok).toBeTruthy();
    const refused = await request.post('/api/meetings', {
      data: { relationIds: [s.rel.id], title: 'Weekly', scheduledAt: '2026-09-01T10:00:00.000Z', meetLink: '' },
    });
    expect(refused.status()).toBe(422);
    expect((await refused.json()).code).toBe('external_link_required');
    expect(await prisma.meeting.count({ where: { relationId: s.rel.id } })).toBe(0);

    // An instant meeting has no paste box: the same refusal, the same code.
    const instant = await request.post('/api/meetings/instant', { data: { title: 'Now', relationIds: [s.rel.id] } });
    expect(instant.status()).toBe(422);
    expect((await instant.json()).code).toBe('external_link_required');

    const pasted = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0';
    const ok = await request.post('/api/meetings', {
      data: { relationIds: [s.rel.id], title: 'Weekly', scheduledAt: '2026-09-01T10:00:00.000Z', meetLink: pasted },
    });
    expect(ok.ok()).toBeTruthy();
    const meeting = await prisma.meeting.findFirst({ where: { relationId: s.rel.id } });
    expect(meeting?.meetLink).toBe(pasted);
  } finally {
    await s.cleanup();
  }
});

test('REQUIRE_EXTERNAL: a saved personal room satisfies the policy, on the instant path too', async ({ request }) => {
  const s = await seedOrgPair('byol-require-room', 'REQUIRE_EXTERNAL', PERSONAL);
  try {
    expect((await signInViaApi(request, s.mentorEmail, 'MentorPass123')).ok).toBeTruthy();
    const instant = await request.post('/api/meetings/instant', { data: { title: 'Now', relationIds: [s.rel.id] } });
    expect(instant.ok()).toBeTruthy();
    expect((await instant.json()).meetLink).toBe(PERSONAL);
  } finally {
    await s.cleanup();
  }
});

// Tagged @smoke: a security guard. A meeting link rides in e-mails we send, so
// one pointing back at our own host is an open-redirect-shaped phishing vector,
// and one carrying credentials leaks them to every invitee.
test('a pasted link that is http, carries credentials or points at our own host is refused — nowhere it is accepted', { tag: '@smoke' }, async ({ request, baseURL }) => {
  const s = await seedOrgPair('byol-invalid', 'BUILTIN', null);
  try {
    expect((await signInViaApi(request, s.mentorEmail, 'MentorPass123')).ok).toBeTruthy();
    const ownHost = new URL(baseURL!).hostname;
    const bad: [string, string][] = [
      ['http://meet.google.com/abc-defg-hij', 'not_https'],
      ['https://user:secret@zoom.us/j/1', 'credentials'],
      [`https://${ownHost}/auth/signin?callbackUrl=/x`, 'own_host'],
    ];
    for (const [meetLink, reason] of bad) {
      const res = await request.post('/api/meetings', {
        data: { relationIds: [s.rel.id], title: 'Bad', scheduledAt: '2026-09-01T10:00:00.000Z', meetLink },
      });
      expect(res.status(), meetLink).toBe(400);
      const body = await res.json();
      expect(body.code, meetLink).toBe('invalid_link');
      expect(body.reason, meetLink).toBe(reason);
    }
    expect(await prisma.meeting.count({ where: { relationId: s.rel.id } })).toBe(0);

    // The saved personal room goes through the same door.
    for (const [personalMeetingUrl, reason] of bad) {
      const res = await request.put('/api/profile', { data: { personalMeetingUrl } });
      expect(res.status(), personalMeetingUrl).toBe(400);
      const body = await res.json();
      expect(body.code, personalMeetingUrl).toBe('invalid_meeting_link');
      expect(body.reason, personalMeetingUrl).toBe(reason);
    }
    const stored = await prisma.user.findUnique({ where: { id: s.mentor.id }, select: { personalMeetingUrl: true } });
    expect(stored?.personalMeetingUrl).toBeNull();
  } finally {
    await s.cleanup();
  }
});

test('the personal room is saved and cleared through /api/profile', async ({ request }) => {
  const s = await seedOrgPair('byol-profile', 'PREFER_PERSONAL', null);
  try {
    expect((await signInViaApi(request, s.mentorEmail, 'MentorPass123')).ok).toBeTruthy();
    const saved = await request.put('/api/profile', { data: { personalMeetingUrl: `  ${PERSONAL}  ` } });
    expect(saved.ok()).toBeTruthy();
    expect((await saved.json()).user.personalMeetingUrl).toBe(PERSONAL);
    expect((await (await request.get('/api/profile')).json()).user.personalMeetingUrl).toBe(PERSONAL);

    const cleared = await request.put('/api/profile', { data: { personalMeetingUrl: '' } });
    expect(cleared.ok()).toBeTruthy();
    expect((await cleared.json()).user.personalMeetingUrl).toBeNull();
  } finally {
    await s.cleanup();
  }
});

test('the conferencing policy is set by the org’s own admin, read back, and refused to another tenant’s admin', async ({ request, browser }) => {
  const s = await seedOrgPair('byol-admin', 'BUILTIN', null);
  const adminEmail = uniqueEmail('byol-admin');
  const admin = await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'BYOL Admin', s.org.id);
  const otherOrg = await prisma.organization.create({ data: { name: 'BYOL other', slug: `byol-other-${Date.now()}` } });
  const otherAdminEmail = uniqueEmail('byol-other-admin');
  const otherAdmin = await seedUser(otherAdminEmail, 'AdminPass123', 'ADMIN', 'BYOL Other Admin', otherOrg.id);
  const url = `/api/admin/organizations/${s.org.id}/conferencing`;
  try {
    // Anonymous: 401. A mentor: 403.
    expect((await request.get(url)).status()).toBe(401);
    expect((await signInViaApi(request, s.mentorEmail, 'MentorPass123')).ok).toBeTruthy();
    expect((await request.patch(url, { data: { policy: 'REQUIRE_EXTERNAL' } })).status()).toBe(403);

    // The org's own admin.
    const ctx = await browser.newContext();
    expect((await signInViaApi(ctx.request, adminEmail, 'AdminPass123')).ok).toBeTruthy();
    expect((await (await ctx.request.get(url)).json()).policy).toBe('BUILTIN');
    const set = await ctx.request.patch(url, { data: { policy: 'REQUIRE_EXTERNAL' } });
    expect(set.ok()).toBeTruthy();
    expect((await set.json()).policy).toBe('REQUIRE_EXTERNAL');
    expect((await (await ctx.request.get(url)).json()).policy).toBe('REQUIRE_EXTERNAL');
    expect((await ctx.request.patch(url, { data: { policy: 'ZOOM_ONLY' } })).status()).toBe(400);
    await ctx.close();

    // And now the mentor's schedule without a link is refused — the policy bites.
    const refused = await request.post('/api/meetings', {
      data: { relationIds: [s.rel.id], title: 'Weekly', scheduledAt: '2026-09-01T10:00:00.000Z', meetLink: '' },
    });
    expect(refused.status()).toBe(422);

    // Another tenant's admin: 403, and the policy is untouched.
    const other = await browser.newContext();
    expect((await signInViaApi(other.request, otherAdminEmail, 'AdminPass123')).ok).toBeTruthy();
    expect((await other.request.get(url)).status()).toBe(403);
    expect((await other.request.patch(url, { data: { policy: 'BUILTIN' } })).status()).toBe(403);
    await other.close();
    const row = await prisma.organization.findUnique({ where: { id: s.org.id }, select: { conferencingPolicy: true } });
    expect(row?.conferencingPolicy).toBe('REQUIRE_EXTERNAL');
  } finally {
    await cleanupByEmail(admin.email);
    await cleanupByEmail(otherAdmin.email);
    await prisma.organization.delete({ where: { id: otherOrg.id } }).catch(() => {});
    await s.cleanup();
  }
});
