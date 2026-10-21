import { test, expect } from '@playwright/test';
import { prisma } from './helpers/db';
import { prisma as appPrisma } from '@/lib/prisma';
import { resolveTemplate } from '@/lib/notifications/templates';

// The notification template chain (#1718) against a real database: programme
// row → org row → code default, per recipient locale, isolated per org, and a
// broken row degrading to the code default with its reason. In-process — the
// resolver is a library call; the renderer's hostile-input cases are unit tests
// (scripts/test/notification-templates.test.mjs).

const RUN = Date.now().toString(36);
const BRAND = { name: 'Acme Sales', url: 'https://app.acme.example' };
let orgA = '';
let orgB = '';

test.beforeAll(async () => {
  orgA = (await prisma.organization.create({ data: { name: `Tpl A ${RUN}`, slug: `tpl-a-${RUN}` } })).id;
  orgB = (await prisma.organization.create({ data: { name: `Tpl B ${RUN}`, slug: `tpl-b-${RUN}` } })).id;
  await prisma.notificationTemplate.createMany({
    data: [
      { orgId: orgA, eventKey: 'stage.changed', locale: 'en', subject: 'Moved: {{from}} → {{to}}', body: '<p>Hi {{recipient.firstName}}, {{brand.name}} moved you to <strong>{{to}}</strong>.</p>' },
      { orgId: orgA, programId: `prog-${RUN}`, eventKey: 'stage.changed', locale: 'en', subject: 'Programme: {{to}}', body: '<p>Programme says {{to}}</p>' },
      { orgId: orgA, eventKey: 'stage.changed', locale: 'tr', subject: '{{offerAmount}}', body: '<p>bozuk</p>' },
      { orgId: orgA, eventKey: 'stale_mentee.noContact', locale: 'en', subject: 'Check in', body: '<script>alert(1)</script>' },
    ],
  });
});

test.afterAll(async () => {
  await prisma.notificationTemplate.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } });
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

const params = { from: 'Application', to: 'Interview' };

test('an org row overrides the code default for that org only', { tag: '@smoke' }, async () => {
  const a = await resolveTemplate('stage.changed', 'en', { orgId: orgA, params, recipientName: 'Ada Lovelace', brand: BRAND });
  expect(a).toMatchObject({ source: 'org', subject: 'Moved: Application → Interview' });
  expect(a.html).toBe('<p>Hi Ada, Acme Sales moved you to <strong>Interview</strong>.</p>');

  // Another tenant: the code default, untouched.
  const b = await resolveTemplate('stage.changed', 'en', { orgId: orgB, params, brand: BRAND });
  expect(b).toMatchObject({ source: 'default', subject: 'Your stage changed: Application → Interview.' });
  expect(b.fallback).toBeUndefined();
  // No org at all: the code default.
  expect((await resolveTemplate('stage.changed', 'en', { orgId: null, params })).source).toBe('default');
});

test('a programme row overrides its org row; no programme means the org row', async () => {
  const p = await resolveTemplate('stage.changed', 'en', { orgId: orgA, programId: `prog-${RUN}`, params, brand: BRAND });
  expect(p).toMatchObject({ source: 'program', subject: 'Programme: Interview' });
  const other = await resolveTemplate('stage.changed', 'en', { orgId: orgA, programId: 'some-other-programme', params, brand: BRAND });
  expect(other.source).toBe('org');
});

test('a missing locale is the code default in that locale, never another language', async () => {
  const de = await resolveTemplate('stage.changed', 'de', { orgId: orgA, params, brand: BRAND });
  expect(de).toMatchObject({ source: 'default', subject: 'Deine Phase hat sich geändert: Application → Interview.' });
  expect(de.fallback).toBeUndefined();
});

test('a broken row falls back to the code default and says why', async () => {
  const tr = await resolveTemplate('stage.changed', 'tr', { orgId: orgA, params, brand: BRAND });
  expect(tr).toMatchObject({ source: 'default', fallback: 'unknown_subject_tag', subject: 'Aşaman değişti: Application → Interview.' });
  expect(tr.templateId).toBeTruthy();

  const scripted = await resolveTemplate('stale_mentee.noContact', 'en', { orgId: orgA, params: { menteeName: 'Ada' }, brand: BRAND });
  expect(scripted).toMatchObject({ source: 'default', fallback: 'empty_body', subject: 'No recent contact with Ada.' });
  expect(scripted.html).not.toContain('<script');
});

test('an unknown event key is a programming error, not a silent default', async () => {
  await expect(resolveTemplate('no.such.event', 'en', { orgId: orgA })).rejects.toThrow(/Unknown notification event/);
});
