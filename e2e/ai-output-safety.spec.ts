import { test, expect } from '@playwright/test';
import { cleanupMenteeWithRelation, prisma, seedMenteeWithRelation, type SeededRelation } from './helpers/db';
import { gotoSettled, signInAsFreshUser } from './helpers/auth';
import { hashInput } from '../src/lib/ai/artifacts';
import { defaultOrgId } from '../src/lib/defaultOrg';

// Output safety (#2026): what a model returns is untrusted — a crafted CV or
// message can steer it. Here the stored catch-up is exactly what a steered
// reply would look like: markup, a javascript: link, a token-carrying URL and
// a bidi override. It must reach the screen as inert text: no element, no
// anchor, no script run, the override gone. CI has no provider key, so the
// stored artefact is how a reply appears at all.

const PASSWORD = 'AiOutput123!';
const HOSTILE = [
  '• Ada asked to move the check-in.',
  '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>',
  '[Click to verify](javascript:window.__pwned=3) https://evil.example/steal?token=abc123',
  'Reversed: ‮evil‬ done.',
].join('\n');
let pair: SeededRelation;
let conversationId = '';

test.beforeAll(async () => {
  pair = await seedMenteeWithRelation('ai-output', PASSWORD);
  await prisma.user.update({ where: { id: pair.mentorId }, data: { preferredLanguage: 'en' } });
  conversationId = (
    await prisma.conversation.create({
      data: { type: 'DIRECT', directKey: [pair.mentorId, pair.menteeId].sort().join('|'), participants: { create: [{ userId: pair.mentorId }, { userId: pair.menteeId }] } },
    })
  ).id;
  const last = await prisma.message.create({ data: { conversationId, senderId: pair.menteeId, body: 'Können wir verschieben?', readAt: new Date() } });
  await prisma.userConsent.create({ data: { userId: pair.menteeId, type: 'AI_INTERACTION_SUMMARY', grantedAt: new Date() } });
  const mentor = await prisma.user.findUnique({ where: { id: pair.mentorId }, select: { orgId: true } });
  await prisma.aiArtifact.create({
    data: {
      orgId: mentor?.orgId ?? (await defaultOrgId()),
      taskId: 'thread_summary',
      subjectUserId: null,
      createdById: pair.mentorId,
      content: HOSTILE,
      inputHash: hashInput({ conversationId, reader: pair.mentorId, last: last.id, edited: null, locale: 'en' }),
    },
  });
});

test.afterAll(async () => {
  await prisma.aiArtifact.deleteMany({ where: { createdById: pair?.mentorId } });
  if (pair) await cleanupMenteeWithRelation(pair);
});

test('a steered model reply renders as inert text: no markup, no live link, no script, no bidi override', { tag: '@smoke' }, async ({ page }) => {
  await signInAsFreshUser(page, pair.mentorEmail, PASSWORD, '/mentor');
  await gotoSettled(page, `/messages/c/${conversationId}`);
  const summary = page.locator('[data-testid=thread-catchup-summary]:visible');
  await expect(async () => {
    await page.locator('[data-testid=thread-catchup-button]:visible').click();
    await expect(summary).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });

  const text = summary.locator('[data-ai-text]');
  // The markup is shown as the characters it is made of…
  await expect(text).toContainText('<img src=x onerror="window.__pwned=1">');
  await expect(text).toContainText('<script>window.__pwned=2</script>');
  await expect(text).toContainText('https://evil.example/steal?token=abc123');
  // …and none of it became an element, a link or a run script.
  await expect(text.locator('img, script, a, iframe')).toHaveCount(0);
  await expect(summary.getByRole('link', { name: /verify/i })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  // The bidi override is stripped, the words around it kept.
  const content = (await text.textContent()) ?? '';
  expect(content).not.toMatch(/[‪-‮⁦-⁩]/);
  expect(content).toContain('Reversed: evil done.');
});
