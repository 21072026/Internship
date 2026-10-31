import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle, signInViaApi } from './helpers/auth';

// The board pages its columns (#1438): each column's header is the TRUE count,
// only the first page of cards is loaded, and "show more" fetches the rest.
// `?pageSize=` alone now pages the plain list instead of being ignored.
async function seedBoard(stamp: string, cards: number) {
  const org = await prisma.organization.create({ data: { name: `Board pages ${stamp}`, slug: `board-pages-${stamp}` } });
  const pw = 'BoardPages123!';
  const adminEmail = uniqueEmail('bp-admin');
  await seedUser(adminEmail, pw, 'ADMIN', `BP Admin ${stamp}`, org.id);
  const mentor = await seedUser(uniqueEmail('bp-mentor'), pw, 'MENTOR', `BP Mentor ${stamp}`, org.id);
  await prisma.user.createMany({
    data: Array.from({ length: cards }, (_, i) => ({
      email: `bp-mentee-${i}.${stamp}@example.test`,
      password: '!x',
      role: 'MENTEE' as const,
      fullName: `BP Mentee ${String(i).padStart(2, '0')} ${stamp}`,
      skills: [],
      orgId: org.id,
    })),
  });
  const mentees = await prisma.user.findMany({ where: { orgId: org.id, role: 'MENTEE' }, select: { id: true } });
  await prisma.mentorshipRelation.createMany({
    data: mentees.map((m, i) => ({
      mentorId: mentor.id,
      menteeId: m.id,
      orgId: org.id,
      status: 'ACTIVE' as const,
      pipelineStatus: 'INTERVIEW_PENDING_250',
      startDate: new Date(Date.now() - i * 60_000),
    })),
  });
  return { org, adminEmail, pw };
}

async function dropOrg(orgId: string) {
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
  await prisma.user.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
}

test('board view: true column counts, one page of cards, a further page per column; pageSize alone pages', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { org, adminEmail, pw } = await seedBoard(stamp, 25);
  const api = await playwright.request.newContext({ baseURL });
  try {
    expect((await signInViaApi(api, adminEmail, pw)).ok).toBe(true);
    const first = await (await api.get('/api/mentorship?view=board')).json();
    expect(first.counts.INTERVIEW_PENDING_250).toBe(25);
    expect(first.relations).toHaveLength(20);
    expect(first.perStage).toBe(20);

    const second = await (await api.get('/api/mentorship?view=board&stage=INTERVIEW_PENDING_250&page=2')).json();
    expect(second.relations).toHaveLength(5);
    const ids = new Set([...first.relations, ...second.relations].map((r: { id: string }) => r.id));
    expect(ids.size).toBe(25);

    expect((await api.get(`/api/mentorship?view=board&stage=${encodeURIComponent("x' OR 1")}`)).status()).toBe(400);

    // Not silently the whole list any more.
    const paged = await (await api.get('/api/mentorship?pageSize=7')).json();
    expect(paged.relations).toHaveLength(7);
    expect(paged.total).toBe(25);
  } finally {
    await api.dispose();
    await dropOrg(org.id);
  }
});

test('the admin board shows the true count and loads the rest of a column on demand', async ({ page }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { org, adminEmail, pw } = await seedBoard(stamp, 25);
  try {
    await signInAndSettle(page, adminEmail, pw, '/admin');
    await gotoSettled(page, '/admin/board');
    const column = page.getByTestId('board-column-INTERVIEW_PENDING_250');
    await expect(column.getByTestId('board-card')).toHaveCount(20, { timeout: 30_000 });
    await expect(column).toContainText('25');
    await column.getByTestId('board-load-more-INTERVIEW_PENDING_250').click();
    await expect(column.getByTestId('board-card')).toHaveCount(25);
    await expect(column.getByTestId('board-load-more-INTERVIEW_PENDING_250')).toHaveCount(0);
  } finally {
    await dropOrg(org.id);
  }
});
