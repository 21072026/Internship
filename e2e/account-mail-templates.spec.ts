import { test, expect, type APIRequestContext } from '@playwright/test';
import { cleanupCustomPipelineOrg, prisma, seedCustomPipelineOrg } from './helpers/db';
import { signInViaApi } from './helpers/auth';
import { renderNotificationEmail } from '../src/lib/notifications/emailRender';
import { sendPasswordResetEmail } from '../src/services/emailService';
import { dictionaries } from '../src/i18n/dictionaries';

// Account mails through the template editor (#3399): invitation, password
// reset and verification take the org's wording, while the one-time link stays
// the code's — drawn as the button and the "copy this link" line whatever the
// template says. No template, the bespoke mail it always was. A throwaway org.

const PW = 'AccountMail123!';
let seeded: Awaited<ReturnType<typeof seedCustomPipelineOrg>>;
let admin: APIRequestContext;
const TOKEN_URL = 'https://app.example/auth/register?token=tok_abc123';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }, info) => {
  seeded = await seedCustomPipelineOrg('acctmail', PW);
  admin = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  expect((await signInViaApi(admin, seeded.adminEmail, PW)).ok).toBe(true);
});

test.afterAll(async () => {
  await admin?.dispose();
  if (seeded) {
    await prisma.notificationTemplate.deleteMany({ where: { orgId: seeded.org.id } });
    await prisma.emailLog.deleteMany({ where: { orgId: seeded.org.id } });
    await cleanupCustomPipelineOrg(seeded.org.id, seeded.emails);
  }
});

const count = (s: string, needle: string) => s.split(needle).length - 1;

test('no template: the invitation is the bespoke mail, link in the button and the copy line', async () => {
  const I = dictionaries.en.notifications.invitationEmail;
  const mail = await renderNotificationEmail({ eventKey: 'account.invitation', locale: 'en', orgId: seeded.org.id, params: { role: 'MENTOR' }, actionUrl: TOKEN_URL });
  expect(mail.source).toBe('default');
  expect(mail.subject).toBe(I.subject.replace('{brand}', mail.fromName));
  expect(mail.html).toContain('<strong>a mentor</strong>');
  expect(mail.html).toContain(I.cta);
  expect(count(mail.html, TOKEN_URL)).toBe(2);
});

test('a hostile template changes the wording but cannot remove or replace the token link', async () => {
  const put = await admin.put('/api/admin/notification-templates', {
    data: {
      eventKey: 'account.invitation',
      locale: 'tr',
      subject: '{{brand.name}} seni {{role}} olarak bekliyor',
      body: '<p>Selam! <a href="https://evil.example/phish">Buraya tıkla</a> <script>alert(1)</script></p>',
    },
  });
  expect(put.ok()).toBe(true);

  const tr = await renderNotificationEmail({ eventKey: 'account.invitation', locale: 'tr', orgId: seeded.org.id, params: { role: 'MENTEE' }, actionUrl: TOKEN_URL });
  expect(tr.source).toBe('org');
  expect(tr.subject).toBe(`${tr.fromName} seni ${dictionaries.tr.notifications.invitationEmail.roles.MENTEE} olarak bekliyor`);
  expect(tr.html).toContain('Selam!');
  expect(tr.html).not.toContain('<script');
  // The code's link is still the button and the copy line.
  expect(tr.html).toContain(`<a href="${TOKEN_URL}"`);
  expect(count(tr.html, TOKEN_URL)).toBe(2);
  expect(tr.html).toContain(dictionaries.tr.notifications.invitationEmail.cta);

  // English has no row: still the bespoke mail.
  const en = await renderNotificationEmail({ eventKey: 'account.invitation', locale: 'en', orgId: seeded.org.id, params: { role: 'MENTEE' }, actionUrl: TOKEN_URL });
  expect(en.source).toBe('default');
});

test('the editor preview is the same renderer, with a dead sample link', async () => {
  const draft = { subject: 'Doğrula {{name}}', body: '<p>Merhaba {{recipient.firstName}}</p>' };
  const res = await admin.post('/api/admin/notification-templates/preview', { data: { eventKey: 'account.verification', locale: 'tr', ...draft } });
  expect(res.ok()).toBe(true);
  const preview = await res.json();
  expect(preview.subject).toBe('Doğrula [name]');
  expect(preview.html).toContain('/auth/verify?token=preview');
  expect(preview.html).toContain(dictionaries.tr.notifications.verificationEmail.cta);
});

test('a reset template reaches the real reset mail; SET_INITIAL keeps its own copy', async () => {
  const put = await admin.put('/api/admin/notification-templates', {
    data: { eventKey: 'account.passwordReset', locale: 'en', subject: 'New password for {{name}}', body: '<p>Pick a new one, {{recipient.firstName}}.</p>' },
  });
  expect(put.ok()).toBe(true);
  const to = seeded.adminEmail;

  await sendPasswordResetEmail({ to, token: 'tok_reset', fullName: 'Ada Lovelace', purpose: 'RESET', orgId: seeded.org.id, locale: 'en' });
  const reset = await prisma.emailLog.findFirst({ where: { to, category: 'password-reset' }, orderBy: { createdAt: 'desc' }, select: { subject: true } });
  expect(reset?.subject).toBe('New password for Ada Lovelace');

  const initial = await renderNotificationEmail({
    eventKey: 'account.passwordReset',
    locale: 'en',
    orgId: seeded.org.id,
    params: { name: 'Ada' },
    actionUrl: 'https://app.example/auth/reset?token=tok_init',
    bespokeOnly: true,
  });
  expect(initial.source).toBe('default');
  expect(initial.html).toContain(dictionaries.en.notifications.passwordResetEmail.setInitial.cta);
  expect(initial.html).toContain('token=tok_init');

  // Reset restores the default.
  const del = await admin.delete(`/api/admin/notification-templates?eventKey=account.passwordReset&locale=en`);
  expect(del.ok()).toBe(true);
  const back = await renderNotificationEmail({ eventKey: 'account.passwordReset', locale: 'en', orgId: seeded.org.id, params: { name: 'Ada' }, actionUrl: 'https://app.example/x' });
  expect(back.source).toBe('default');
  expect(back.subject).toBe(dictionaries.en.notifications.passwordResetEmail.reset.subject.replace('{brand}', back.fromName));
});
