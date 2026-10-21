import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { defaultOrgId } from '../src/lib/defaultOrg';
import { prisma as appPrisma } from '../src/lib/prisma';

// #1818: the shared skills field suggests the org's canonical vocabulary, and
// every save dual-writes — the free-text `User.skills` exactly as before AND the
// `UserSkill` rows it resolves to. A term nobody curated is kept and queued for
// curation, never dropped.

const PASSWORD = 'MenteePass123';
const FREE_TERM = `Underwater Basket Weaving ${Date.now().toString(36)}`;

test.afterAll(async () => {
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

test('profile: typing "rea" suggests React; saving writes UserSkill and keeps the JSON', { tag: '@smoke' }, async ({ page }) => {
  const email = uniqueEmail('picker-mentee');
  const orgId = await defaultOrgId();
  const user = await seedUser(email, PASSWORD, 'MENTEE', 'Picker Mentee', orgId);
  const input = page.getByTestId('skills-field-input');

  try {
    await signInAndSettle(page, email, PASSWORD, '/portal');

    await page.goto('/portal/profile');
    await expect(input).toBeVisible();

    await input.fill('rea');
    const listbox = page.getByTestId('skills-field-listbox');
    await expect(listbox.getByRole('option', { name: 'React', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(input).toHaveAttribute('aria-expanded', 'true');

    // Keyboard: move onto "React" and pick it.
    const options = listbox.getByRole('option');
    const names = await options.allTextContents();
    for (let i = 0; i <= names.indexOf('React'); i++) await input.press('ArrowDown');
    await expect(input).toHaveAttribute('aria-activedescendant', /skills-field-listbox-\d+/);
    await input.press('Enter');
    await expect(page.getByTestId('skills-field-chip').filter({ hasText: 'React' })).toHaveCount(1);
    await expect(input).toHaveValue('');

    // A term the vocabulary does not know is still accepted with Enter.
    await input.fill(FREE_TERM);
    await input.press('Escape');
    await input.press('Enter');
    await expect(page.getByTestId('skills-field-chip')).toHaveCount(2);

    await page.getByRole('button', { name: /save/i }).first().click();

    const react = await prisma.skill.findFirstOrThrow({ where: { orgId, key: 'react' }, select: { id: true } });
    await expect
      .poll(async () => prisma.userSkill.count({ where: { userId: user.id, skillId: react.id } }), { timeout: 15_000 })
      .toBe(1);
    const saved = await prisma.user.findUnique({ where: { id: user.id }, select: { skills: true } });
    expect(saved?.skills).toEqual(['React', FREE_TERM]);
    const queued = await prisma.unmappedSkillTerm.findFirst({
      where: { orgId, term: FREE_TERM },
      select: { resolution: true },
    });
    expect(queued?.resolution).toBe('PENDING');
  } finally {
    await prisma.unmappedSkillTerm.deleteMany({ where: { term: FREE_TERM } });
    await cleanupByEmail(email);
  }
});

test('suggest: signed out it answers only for a public form context, rate-limited, labels only', { tag: '@smoke' }, async ({ request }) => {
  const bare = await request.get('/api/skills/suggest?q=rea');
  expect(bare.ok()).toBe(true);
  expect((await bare.json()).suggestions).toEqual([]);

  const unknownMentor = await request.get('/api/skills/suggest?q=rea&mentorId=does-not-exist');
  expect((await unknownMentor.json()).suggestions).toEqual([]);

  const form = await request.get('/api/skills/suggest?q=rea&context=mentor-application');
  const { suggestions } = await form.json();
  expect(suggestions.map((s: { label: string }) => s.label)).toContain('React');
  expect(Object.keys(suggestions[0]).sort()).toEqual(['id', 'key', 'label']);
});
