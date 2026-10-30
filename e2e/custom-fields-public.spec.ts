import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { freshIp } from './helpers/rateLimit';
import { signInViaApi } from './helpers/auth';

// Admin-defined questions on the PUBLIC forms (#1803, slice 3b).
//   • the per-mentor apply link shows the mentor's org's REGISTRATION question,
//     refuses a bad answer before any account exists, and writes a good one
//     onto the account it creates;
//   • the become-a-mentor application stages its answers on the row, and the
//     invitation it is approved into carries them onto the new mentor account,
//     after which the row no longer holds them.

const L = (en: string) => ({ en, tr: `${en} (tr)`, de: `${en} (de)` });

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('apply link: the question is shown, a bad answer creates nothing, a good one lands on the new account', async ({ page }) => {
  test.slow();
  const stamp = `${Date.now()}`;
  const org = await prisma.organization.create({ data: { name: `CFP Org ${stamp}`, slug: `cfp-${stamp}` } });
  const mentorEmail = uniqueEmail('cfp-mentor');
  const applicant = uniqueEmail('cfp-applicant');
  const refused = uniqueEmail('cfp-refused');
  try {
    const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'CFP Mentor', org.id);
    const form = await prisma.formDefinition.create({
      data: {
        orgId: org.id, key: 'mentee_registration', audience: 'MENTEE', surface: 'REGISTRATION', version: 1, publishedAt: new Date(),
        fields: { create: [{ key: 'track', type: 'SELECT', labels: L('Track'), required: true, sortOrder: 0, options: [{ value: 'web', labels: L('Web') }, { value: 'data', labels: L('Data') }] }] },
      },
    });

    // The API refuses before an account exists: a wrong option, a missing required answer, an unknown form.
    for (const formAnswers of [[{ definitionId: form.id, answers: { track: 'nope' } }], [], [{ definitionId: 'not-a-form', answers: {} }]]) {
      const res = await page.request.post('/api/apply', { headers: freshIp(`cfp ${JSON.stringify(formAnswers)}`), data: { mentorId: mentor.id, fullName: 'Refused', email: refused, formAnswers } });
      expect([res.status(), (await res.json()).code]).toEqual([400, 'invalid_answers']);
    }
    expect(await prisma.user.count({ where: { email: refused } })).toBe(0);

    // The page shows the question and holds the submit until it is answered.
    await page.goto(`/apply/${mentor.id}`);
    await expect(page.getByTestId('dynamic-fields').getByText('Track')).toBeVisible({ timeout: 60_000 });
    await page.getByLabel(/Full name/i).fill('CFP Applicant');
    await page.getByLabel(/E-?mail/i).fill(applicant);
    await page.getByRole('button', { name: /Apply|Submit|Send/i }).click();
    await expect(page.getByTestId('custom-field-track-error')).toBeVisible();
    await page.getByTestId('custom-field-track').selectOption('data');
    await page.getByRole('button', { name: /Apply|Submit|Send/i }).click();
    await expect.poll(() => prisma.user.count({ where: { email: applicant } }), { timeout: 30_000 }).toBe(1);
    const created = await prisma.user.findFirstOrThrow({ where: { email: applicant } });
    expect((await prisma.formResponse.findFirst({ where: { userId: created.id, fieldKey: 'track' } }))?.value).toBe('data');
  } finally {
    await prisma.mentorshipRequest.deleteMany({ where: { mentee: { email: { in: [applicant, refused] } } } });
    for (const email of [applicant, refused, mentorEmail]) await cleanupByEmail(email);
    await prisma.formDefinition.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});

test('mentor application: answers are staged, then carried onto the account the invitation creates', async ({ page }) => {
  const defaultOrg = await prisma.organization.upsert({ where: { slug: 'default' }, update: {}, create: { slug: 'default', name: 'Default Organization' }, select: { id: true } });
  const stamp = `${Date.now()}`;
  const key = `mentor_reg_${stamp}`;
  const email = uniqueEmail('cfp-mentor-app');
  const adminEmail = uniqueEmail('cfp-admin');
  // OPTIONAL on purpose: this form lives in the shared default org, and a
  // required question there would refuse every other spec's mentor application.
  const form = await prisma.formDefinition.create({
    data: {
      orgId: defaultOrg.id, key, audience: 'MENTOR', surface: 'REGISTRATION', version: 1, publishedAt: new Date(),
      fields: { create: [{ key: 'sector', type: 'SELECT', labels: L('Sector'), sortOrder: 0, options: [{ value: 'fin', labels: L('Finance') }, { value: 'health', labels: L('Health') }] }] },
    },
  });
  try {
    const listed = await (await page.request.get('/api/forms/public?for=mentor-application')).json();
    expect(listed.forms.some((f: { id: string }) => f.id === form.id)).toBe(true);
    expect(JSON.stringify(listed)).not.toContain('matchable');

    const applied = await page.request.post('/api/mentor-applications', {
      headers: freshIp(`cfp-mentor-app ${stamp}`),
      data: { fullName: 'CFP Mentor Applicant', email, expertise: ['Finance'], formAnswers: [{ definitionId: form.id, answers: { sector: 'health' } }] },
    });
    expect(applied.status()).toBe(200);
    const application = await prisma.mentorApplication.findFirstOrThrow({ where: { email } });
    expect(application.formAnswers).toEqual([{ definitionId: form.id, answers: { sector: 'health' } }]);

    // Approved by an admin of the default org: an invitation, no account yet.
    await seedUser(adminEmail, 'CfpAdmin123!', 'ADMIN', 'CFP Admin', defaultOrg.id);
    expect((await signInViaApi(page.request, adminEmail, 'CfpAdmin123!')).ok).toBe(true);
    const approved = await page.request.patch(`/api/mentor-applications/${application.id}`, { data: { action: 'approve' } });
    expect(approved.status(), await approved.text()).toBe(200);
    const invite = await prisma.invitationToken.findFirstOrThrow({ where: { email } });

    // Registering through the invitation carries the answer onto the new mentor.
    await page.context().clearCookies();
    const registered = await page.request.post('/api/register', {
      headers: freshIp(`cfp-register ${stamp}`),
      data: { token: invite.token, email, password: 'CfpMentor123!', fullName: 'CFP Mentor Applicant' },
    });
    expect(registered.status(), await registered.text()).toBe(201);
    const mentor = await prisma.user.findFirstOrThrow({ where: { email } });
    expect(mentor.role).toBe('MENTOR');
    expect((await prisma.formResponse.findFirst({ where: { userId: mentor.id, fieldKey: 'sector' } }))?.value).toBe('health');
    // The application no longer holds them: one place only.
    expect((await prisma.mentorApplication.findUniqueOrThrow({ where: { id: application.id } })).formAnswers).toBeNull();
  } finally {
    await prisma.invitationToken.deleteMany({ where: { email } });
    await prisma.mentorApplication.deleteMany({ where: { email } });
    for (const e of [email, adminEmail]) await cleanupByEmail(e);
    await prisma.formDefinition.deleteMany({ where: { id: form.id } });
  }
});
