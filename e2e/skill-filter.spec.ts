import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('skill filter matches a partial, case-insensitive term', async ({ page }) => {
  const adminEmail = uniqueEmail('skf-admin');
  const menteeEmail = uniqueEmail('skf-mentee');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Skf Admin');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Docker Person');
  await prisma.user.update({ where: { id: mentee.id }, data: { skills: ['Docker', 'Linux'] } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Partial term via the API the page uses.
    const res = await page.request.get('/api/candidates?skills=docke');
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.candidates.some((c: { id: string }) => c.id === mentee.id)).toBeTruthy();
  } finally {
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});

// #1820: the mentor directory used to read the first 500 (later 2000) mentors
// and filter skills in JavaScript, so a mentor holding the skill but sorting
// after the cap did not exist. The skill filter is SQL now — over the canonical
// `UserSkill` rows AND the free text — so both targets below, sorting last
// among 2 050 consented mentors, are found and counted.
test('mentor directory: a skill held only past the old scan cap is found, with an honest total', async ({ request }) => {
  test.setTimeout(180_000);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const org = await prisma.organization.create({ data: { name: `Skf Dir ${stamp}`, slug: `skf-dir-${stamp}` } });
  const menteeEmail = uniqueEmail('skf-dir-mentee');
  await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Skf Dir Mentee', org.id);
  const rare = `Zorbonite${stamp.replace(/[^a-z0-9]/gi, '')}`;

  try {
    const filler = Array.from({ length: 2050 }, (_, i) => ({
      email: `skf-dir-${stamp}-${i}@test.example`,
      password: '!',
      role: 'MENTOR' as const,
      fullName: `A Mentor ${String(i).padStart(4, '0')}`,
      orgId: org.id,
      publicProfile: true,
      skills: ['Common Skill'],
    }));
    await prisma.user.createMany({ data: filler });
    // Two targets that sort after every filler row.
    const freeText = await prisma.user.create({
      data: { email: `skf-dir-${stamp}-ft@test.example`, password: '!', role: 'MENTOR', fullName: 'Zz Free Text', orgId: org.id, publicProfile: true, skills: [rare] },
    });
    const canonical = await prisma.user.create({
      data: { email: `skf-dir-${stamp}-cn@test.example`, password: '!', role: 'MENTOR', fullName: 'Zz Canonical', orgId: org.id, publicProfile: true, skills: [] },
    });
    const skill = await prisma.skill.create({
      data: { orgId: org.id, key: rare.toLowerCase(), labelEn: rare, labelTr: rare, labelDe: rare },
    });
    await prisma.userSkill.create({ data: { userId: canonical.id, skillId: skill.id } });
    const mentors = await prisma.user.findMany({ where: { orgId: org.id, role: 'MENTOR' }, select: { id: true } });
    await prisma.userConsent.createMany({
      data: mentors.map((m) => ({ userId: m.id, type: 'MENTOR_DIRECTORY_VISIBILITY', grantedAt: new Date() })),
    });

    expect((await signInViaApi(request, menteeEmail, 'MenteePass123')).ok).toBe(true);

    const res = await request.get(`/api/mentors?skill=${encodeURIComponent(rare.slice(0, 12))}&pageSize=50`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.partial).toBe(false);
    expect(body.total).toBe(2);
    expect(body.mentors.map((m: { id: string }) => m.id).sort()).toEqual([freeText.id, canonical.id].sort());

    // The common skill counts every filler mentor, from SQL, not a capped scan.
    const common = await (await request.get('/api/mentors?skill=common%20skill&pageSize=1')).json();
    expect(common.total).toBe(2050);
    expect(common.partial).toBe(false);
  } finally {
    await prisma.user.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } });
  }
});
