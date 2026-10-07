import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled } from './helpers/auth';
import { setSetting } from '../src/lib/settings';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1845: the AI-personalised session agenda is participant AI — free, and
// when it cannot be asked (here: the org's monthly quota is 0, and CI has no
// provider key anyway) the answer is the guide as written with the reason,
// never a paywall. The first test is the boundary (hence @smoke): the quota-
// exhausted path through the API, the relation rule, the mentee's consent,
// nothing metered, and the accepted proposal persisting as agenda lines. The
// second drives the panel: the draft, the reason line, add, reload.

const PASSWORD = 'Agenda1234!';
const NEVER = /upgrade|yükselt|upgraden|feature_locked|AI_PACKAGE/i;
const PROMPTS = ['How is the internship going?', 'What got in the way since last time?', 'What would make the next two weeks a success?'];

async function seedPair(prefix: string) {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `AI agenda ${prefix}`, slug: `aiagenda-${stamp}` } });
  // The org's allowance is spent: every call degrades, none reaches a provider.
  await setSetting('aiMonthlyQuota', '0', org.id);
  const mentorEmail = uniqueEmail(`${prefix}-mentor`);
  const menteeEmail = uniqueEmail(`${prefix}-mentee`);
  const strangerEmail = uniqueEmail(`${prefix}-stranger`);
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Agenda AI Mentor');
  const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'Agenda AI Mentee');
  const stranger = await seedUser(strangerEmail, PASSWORD, 'MENTOR', 'Agenda AI Stranger');
  for (const u of [mentor, mentee, stranger]) await prisma.user.update({ where: { id: u.id }, data: { orgId: org.id } });
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE', orgId: org.id, pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450', startDate: new Date(Date.now() - 14 * 86_400_000) },
  });
  await prisma.goal.create({ data: { relationId: rel.id, title: 'Ship the portfolio site', status: 'OPEN', visibility: 'PAIR', createdById: mentor.id, createdByRole: 'MENTOR' } });
  await prisma.interactionLog.create({ data: { relationId: rel.id, type: 'Meeting', subject: 'Kick-off', notes: 'Agreed on a weekly call.', date: new Date() } });
  const template = await prisma.agendaTemplate.create({
    data: {
      orgId: org.id,
      title: `E2E mid-point ${stamp}`,
      translations: { en: `E2E mid-point ${stamp}`, tr: `E2E ara değerlendirme ${stamp}` },
      items: { create: PROMPTS.map((prompt, order) => ({ order, prompt, translations: { en: prompt } })) },
    },
  });
  const cleanup = async () => {
    await prisma.sessionAgenda.deleteMany({ where: { relationId: rel.id } });
    await prisma.agendaTemplate.deleteMany({ where: { id: template.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(strangerEmail);
    await prisma.setting.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  };
  return { org, mentorEmail, menteeEmail, strangerEmail, mentor, mentee, stranger, rel, template, cleanup };
}

test(
  'with the AI allowance spent the guide still renders as the proposal, nothing is metered, no paywall; the relation rule and the consent hold; an accepted proposal persists',
  { tag: '@smoke' },
  async ({ playwright }) => {
    const p = await seedPair('ai-agenda');
    const asMentor = await playwright.request.newContext();
    const asMentee = await playwright.request.newContext();
    const asStranger = await playwright.request.newContext();
    try {
      expect((await signInViaApi(asMentor, p.mentorEmail, PASSWORD)).ok).toBeTruthy();
      expect((await signInViaApi(asMentee, p.menteeEmail, PASSWORD)).ok).toBeTruthy();
      expect((await signInViaApi(asStranger, p.strangerEmail, PASSWORD)).ok).toBeTruthy();
      const usageBefore = await prisma.aiUsage.count();

      // A free-form agenda, and the guide named on the call.
      const started = await asMentor.post('/api/agendas', { data: { relationId: p.rel.id } });
      expect(started.status()).toBe(201);
      const agendaId = (await started.json()).agenda.id as string;

      // Without the mentee's consent: the guide as written, with the reason — and a 200, not a refusal.
      const unconsented = await asMentor.post('/api/agendas/personalize', { data: { agendaId, templateId: p.template.id } });
      expect(unconsented.status()).toBe(200);
      expect(await unconsented.json()).toMatchObject({ source: 'template', reason: 'no_consent', proposals: PROMPTS });

      // The mentee allows it; the allowance is 0, so the answer is still the guide — and still a 200.
      expect((await asMentee.post('/api/consent', { data: { type: 'AI_INTERACTION_SUMMARY', granted: true } })).ok()).toBeTruthy();
      const res = await asMentor.post('/api/agendas/personalize', { data: { agendaId, templateId: p.template.id } });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ source: 'template', reason: 'quota_exceeded', proposals: PROMPTS });
      expect(JSON.stringify(body)).not.toMatch(NEVER);
      // Nothing left the process and nothing was charged.
      expect(await prisma.aiUsage.count()).toBe(usageBefore);

      // Either seat may ask; a third party of the same tenant may not; an unknown agenda is not confirmed.
      expect((await asMentee.post('/api/agendas/personalize', { data: { agendaId } })).status()).toBe(200);
      expect((await asStranger.post('/api/agendas/personalize', { data: { agendaId } })).status()).toBe(403);
      expect((await asMentor.post('/api/agendas/personalize', { data: { agendaId: 'nope' } })).status()).toBe(404);
      expect((await asMentor.post('/api/agendas/personalize', { data: { agendaId, extra: 1 } })).status()).toBe(400);

      // Accepting the proposal writes real lines, in order, in one request — and they survive a reload.
      const accepted = await asMentor.post(`/api/agendas/${agendaId}/items`, { data: { texts: body.proposals } });
      expect(accepted.status()).toBe(201);
      const listed = await asMentor.get(`/api/agendas?relationId=${p.rel.id}`);
      const agenda = ((await listed.json()).agendas as { id: string; items: { text: string; templateItem: unknown }[] }[]).find((a) => a.id === agendaId);
      expect(agenda?.items.map((i) => i.text)).toEqual(PROMPTS);
      expect(agenda?.items.every((i) => i.templateItem === null)).toBeTruthy();
      // With the guide now on the agenda there is nothing new to propose — still the honest shape.
      const again = await asMentor.post('/api/agendas/personalize', { data: { agendaId, templateId: p.template.id } });
      expect(await again.json()).toMatchObject({ source: 'template', reason: 'quota_exceeded', proposals: [] });
      // The bulk shape is bounded: one of text/texts, never both, never more than a proposal holds.
      expect((await asMentor.post(`/api/agendas/${agendaId}/items`, { data: { text: 'a', texts: ['b'] } })).status()).toBe(400);
      expect((await asMentor.post(`/api/agendas/${agendaId}/items`, { data: { texts: Array.from({ length: 8 }, (_, i) => `line ${i}`) } })).status()).toBe(400);
      expect(await prisma.aiUsage.count()).toBe(usageBefore);
    } finally {
      await asMentor.dispose();
      await asMentee.dispose();
      await asStranger.dispose();
      await p.cleanup();
    }
  }
);

test('the panel shows the proposal as a draft with the reason, adds the ticked lines and keeps them after a reload', async ({ page }) => {
  const p = await seedPair('ai-agenda-ui');
  try {
    await prisma.userConsent.create({ data: { userId: p.mentee.id, type: 'AI_INTERACTION_SUMMARY', grantedAt: new Date() } });
    await signInAndSettle(page, p.mentorEmail, PASSWORD, '/mentor');
    // The session is started from the guide, then one line is removed — the
    // honest fallback proposes exactly that line back.
    const started = await page.request.post('/api/agendas', { data: { relationId: p.rel.id, templateId: p.template.id } });
    expect(started.status()).toBe(201);
    const agenda = (await started.json()).agenda as { id: string; items: { id: string }[] };
    expect((await page.request.delete(`/api/agendas/${agenda.id}/items/${agenda.items[1].id}`)).ok()).toBeTruthy();

    await gotoSettled(page, `/mentor/mentees/${p.rel.id}`);
    const panel = page.getByTestId('agenda-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    const items = panel.getByTestId('agenda-items').locator('li');
    await expect(items).toHaveCount(2, { timeout: 15_000 });

    await panel.getByTestId('agenda-ai-suggest').click();
    const draft = panel.getByTestId('agenda-ai-draft');
    await expect(draft).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByTestId('agenda-ai-reason')).toContainText('used up');
    await expect(panel.getByTestId('agenda-ai-lines').locator('li')).toHaveCount(1);
    await expect(draft).toContainText(PROMPTS[1]);
    await expect(panel).not.toContainText(NEVER);
    // A draft: nothing on the agenda yet, and discarding it costs nothing.
    await expect(items).toHaveCount(2);
    await panel.getByTestId('agenda-ai-discard').click();
    await expect(draft).toHaveCount(0);

    await panel.getByTestId('agenda-ai-suggest').click();
    await expect(draft).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByTestId('agenda-ai-accept')).toContainText('Add 1 line');
    await panel.getByTestId('agenda-ai-accept').click();
    await expect(items).toHaveCount(3, { timeout: 15_000 });
    await expect(draft).toHaveCount(0);
    await expect(items.last()).toContainText(PROMPTS[1]);

    await page.reload();
    await expect(panel.getByTestId('agenda-items').locator('li')).toHaveCount(3, { timeout: 15_000 });
    expect(await prisma.sessionAgendaItem.count({ where: { agendaId: agenda.id } })).toBe(3);
  } finally {
    await p.cleanup();
  }
});
