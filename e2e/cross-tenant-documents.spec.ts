import { test, expect, type APIResponse } from '@playwright/test';
import { prisma } from './helpers/db';
import { seedTwoTenants, signInAsTenantActor, type TwoTenants } from './helpers/tenants';

/**
 * Documents & files across tenants (#2542), on the DEFAULT server — the one
 * with MT_ENFORCE_ISOLATION off, which is production today.
 *
 * Document, CvFile, AvatarFile, MessageAttachment and SupportAttachment carry no
 * orgId, so the tenant middleware could never scope them, and the admin-only
 * requirement routes took the org straight from the request. An admin of org B
 * listed, downloaded and deleted org A's documents, CVs, avatars and message /
 * support attachments, and rewrote org A's document requirements. Each route
 * now resolves the row's parent org and answers 404 (never 403) when it is not
 * the caller's. This spec pins both halves: the other org is refused, the
 * owning org — and a super admin, for the requirement config — still gets in.
 *
 * Every user the rest of the suite seeds is org-less, and that path is
 * unchanged by construction (`sameOrgOrUnknown` passes when either side is
 * unknown); the existing documents/avatar/cv/attachment specs cover it.
 */

const PDF = Buffer.from('%PDF-1.4\n% cross-tenant\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('IHDRcross')]);

let tenants: TwoTenants;
let marker: string;
const ids = {
  doc: '', docDel: '', template: '', requirement: '', requirementDel: '',
  relAttachment: '', dmAttachment: '', supportAttachment: '', conversation: '', ticket: '',
};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  tenants = await seedTwoTenants();
  const { orgA } = tenants;
  marker = `XDOC${Date.now()}`;
  const doc = (over: Record<string, unknown>) => prisma.document.create({
    data: {
      uploaderId: orgA.admin.id, type: 'CONTRACT', title: `${marker} doc`, filename: 'c.pdf',
      contentType: 'application/pdf', size: PDF.length, data: PDF, ...over,
    },
  });
  ids.doc = (await doc({ ownerId: orgA.mentee.id })).id;
  ids.docDel = (await doc({ ownerId: orgA.mentee.id, version: 2 })).id;
  ids.template = (await doc({ isTemplate: true, title: `${marker} template` })).id;
  await prisma.cvFile.create({ data: { userId: orgA.mentee.id, filename: 'cv.pdf', contentType: 'application/pdf', size: PDF.length, data: PDF } });
  await prisma.avatarFile.create({ data: { userId: orgA.mentee.id, contentType: 'image/png', size: PNG.length, data: PNG } });
  const label = { en: `${marker} NDA`, tr: `${marker} NDA`, de: `${marker} NDA` };
  ids.requirement = (await prisma.documentRequirement.create({ data: { orgId: orgA.org.id, key: `${marker}_nda`, labels: label, appliesToRole: 'MENTEE' } })).id;
  ids.requirementDel = (await prisma.documentRequirement.create({ data: { orgId: orgA.org.id, key: `${marker}_del`, labels: label, appliesToRole: 'MENTEE', mandatory: false } })).id;

  const relMsg = await prisma.message.create({ data: { relationId: orgA.relation.id, senderId: orgA.mentee.id, body: `${marker} thread` } });
  ids.relAttachment = (await prisma.messageAttachment.create({ data: { messageId: relMsg.id, filename: 'a.pdf', contentType: 'application/pdf', size: PDF.length, data: PDF } })).id;
  const conversation = await prisma.conversation.create({
    data: { type: 'DIRECT', directKey: `${marker}:${orgA.mentor.id}:${orgA.mentee.id}`, participants: { create: [{ userId: orgA.mentor.id }, { userId: orgA.mentee.id }] } },
  });
  ids.conversation = conversation.id;
  const dm = await prisma.message.create({ data: { conversationId: conversation.id, senderId: orgA.mentee.id, body: `${marker} dm` } });
  ids.dmAttachment = (await prisma.messageAttachment.create({ data: { messageId: dm.id, filename: 'b.pdf', contentType: 'application/pdf', size: PDF.length, data: PDF } })).id;
  const ticket = await prisma.supportTicket.create({ data: { requesterId: orgA.mentee.id, subject: `${marker} ticket` } });
  ids.ticket = ticket.id;
  const supportMsg = await prisma.supportMessage.create({ data: { ticketId: ticket.id, senderId: orgA.mentee.id, body: `${marker} help` } });
  ids.supportAttachment = (await prisma.supportAttachment.create({ data: { messageId: supportMsg.id, filename: 's.pdf', contentType: 'application/pdf', size: PDF.length, data: PDF } })).id;
});

test.afterAll(async () => {
  if (tenants) {
    const users = [...tenants.orgA.actors, ...tenants.orgB.actors].map((a) => a.id);
    await prisma.message.deleteMany({ where: { relationId: tenants.orgA.relation.id } });
    if (ids.conversation) {
      await prisma.message.deleteMany({ where: { conversationId: ids.conversation } });
      await prisma.conversation.deleteMany({ where: { id: ids.conversation } });
    }
    if (ids.ticket) await prisma.supportTicket.deleteMany({ where: { id: ids.ticket } });
    await prisma.document.deleteMany({ where: { OR: [{ ownerId: { in: users } }, { uploaderId: { in: users } }] } });
    await prisma.documentRequirement.deleteMany({ where: { orgId: { in: tenants.orgIds } } });
    await tenants.cleanup();
  }
  await prisma.$disconnect();
});

async function bodyOf(res: APIResponse) {
  return (await res.body()).toString('latin1');
}

test('another org\'s admin cannot read org A\'s documents, CVs, avatars or attachments', async ({ page }) => {
  const { orgA, orgB } = tenants;
  await signInAsTenantActor(page, orgB.admin);
  const rq = page.request;

  const notFound = [
    `/api/documents?userId=${orgA.mentee.id}`,
    `/api/documents/${ids.doc}`,
    `/api/documents/${ids.template}`,
    `/api/cv/${orgA.mentee.id}`,
    `/api/avatar/${orgA.mentee.id}`,
    `/api/messages/attachments/${ids.relAttachment}`,
    `/api/messages/attachments/${ids.dmAttachment}`,
    `/api/support/attachments/${ids.supportAttachment}`,
    `/api/admin/document-requirements?orgId=${orgA.org.id}`,
    `/api/admin/documents/missing?orgId=${orgA.org.id}&role=MENTEE`,
  ];
  for (const path of notFound) {
    const res = await rq.get(path);
    expect(res.status(), path).toBe(404);
    expect(await bodyOf(res), path).not.toContain(marker);
  }

  // The template list is shared by design within an org — but only within it.
  const templates = await rq.get('/api/documents?templates=1');
  expect(templates.status()).toBe(200);
  const { documents } = await templates.json();
  expect(documents.map((d: { id: string }) => d.id)).not.toContain(ids.template);
});

test('another org\'s admin cannot change org A\'s files or document requirements', async ({ page }) => {
  const { orgA, orgB } = tenants;
  await signInAsTenantActor(page, orgB.admin);
  const rq = page.request;

  const patch = await rq.patch(`/api/admin/document-requirements/${ids.requirement}`, {
    data: { orgId: orgA.org.id, labels: { en: 'PWNED', tr: 'PWNED', de: 'PWNED' } },
  });
  expect(patch.status()).toBe(404);
  const create = await rq.post('/api/admin/document-requirements', {
    data: { orgId: orgA.org.id, key: `${marker}_injected`, labels: { en: 'x', tr: 'x', de: 'x' } },
  });
  expect(create.status()).toBe(404);
  expect((await rq.delete(`/api/admin/document-requirements/${ids.requirementDel}?orgId=${orgA.org.id}`)).status()).toBe(404);
  expect((await rq.delete(`/api/documents/${ids.docDel}`)).status()).toBe(404);
  expect((await rq.delete(`/api/documents/${ids.template}`)).status()).toBe(404);
  expect((await rq.delete(`/api/cv/${orgA.mentee.id}`)).status()).toBe(404);
  expect((await rq.delete(`/api/avatar/${orgA.mentee.id}`)).status()).toBe(404);
  const upload = await rq.post('/api/documents', {
    multipart: { file: { name: 'x.pdf', mimeType: 'application/pdf', buffer: PDF }, targetUserId: orgA.mentor.id },
  });
  expect(upload.status()).toBe(404);
  const avatarUpload = await rq.post('/api/avatar', {
    multipart: { file: { name: 'x.png', mimeType: 'image/png', buffer: PNG }, targetUserId: orgA.mentor.id },
  });
  expect(avatarUpload.status()).toBe(404);

  // The refusals happened before any write: every row is exactly as seeded.
  const requirement = await prisma.documentRequirement.findUnique({ where: { id: ids.requirement } });
  expect((requirement?.labels as { en: string }).en).toBe(`${marker} NDA`);
  expect(await prisma.documentRequirement.count({ where: { id: ids.requirementDel } })).toBe(1);
  expect(await prisma.documentRequirement.count({ where: { orgId: orgA.org.id, key: `${marker}_injected` } })).toBe(0);
  expect(await prisma.document.count({ where: { id: { in: [ids.docDel, ids.template] } } })).toBe(2);
  expect(await prisma.document.count({ where: { ownerId: orgA.mentor.id } })).toBe(0);
  expect(await prisma.cvFile.count({ where: { userId: orgA.mentee.id } })).toBe(1);
  expect(await prisma.avatarFile.count({ where: { userId: { in: [orgA.mentee.id, orgA.mentor.id] } } })).toBe(1);
});

test('the owning org\'s admin still reads and manages every row', async ({ page }) => {
  const { orgA } = tenants;
  await signInAsTenantActor(page, orgA.admin);
  const rq = page.request;

  const list = await rq.get(`/api/documents?userId=${orgA.mentee.id}`);
  expect(list.status()).toBe(200);
  expect((await list.json()).documents.map((d: { id: string }) => d.id)).toContain(ids.doc);
  const templates = await rq.get('/api/documents?templates=1');
  expect((await templates.json()).documents.map((d: { id: string }) => d.id)).toContain(ids.template);

  for (const path of [
    `/api/documents/${ids.doc}`,
    `/api/documents/${ids.template}`,
    `/api/cv/${orgA.mentee.id}`,
    `/api/avatar/${orgA.mentee.id}`,
    `/api/messages/attachments/${ids.relAttachment}`,
    `/api/messages/attachments/${ids.dmAttachment}`,
    `/api/support/attachments/${ids.supportAttachment}`,
  ]) {
    expect((await rq.get(path)).status(), path).toBe(200);
  }

  const requirements = await rq.get(`/api/admin/document-requirements?orgId=${orgA.org.id}`);
  expect(requirements.status()).toBe(200);
  expect(await bodyOf(requirements)).toContain(ids.requirement);
  const missing = await rq.get(`/api/admin/documents/missing?orgId=${orgA.org.id}&role=MENTEE`);
  expect(missing.status()).toBe(200);
  expect(await bodyOf(missing)).toContain(orgA.mentee.id);

  const patch = await rq.patch(`/api/admin/document-requirements/${ids.requirement}`, {
    data: { orgId: orgA.org.id, order: 3 },
  });
  expect(patch.status()).toBe(200);
  expect((await rq.delete(`/api/documents/${ids.docDel}`)).status()).toBe(200);
  expect(await prisma.document.count({ where: { id: ids.docDel } })).toBe(0);
});

test('a super admin still manages another org\'s document requirements', async ({ page }) => {
  const { orgA, orgB } = tenants;
  await prisma.user.update({ where: { id: orgB.admin.id }, data: { isSuperAdmin: true } });
  try {
    await signInAsTenantActor(page, orgB.admin);
    const res = await page.request.get(`/api/admin/document-requirements?orgId=${orgA.org.id}`);
    expect(res.status()).toBe(200);
    expect(await bodyOf(res)).toContain(ids.requirement);
  } finally {
    await prisma.user.update({ where: { id: orgB.admin.id }, data: { isSuperAdmin: false } });
  }
});

test('a public profile photo stays visible to a signed-in viewer of another org', async ({ page }) => {
  const { orgA, orgB } = tenants;
  await prisma.user.update({ where: { id: orgA.mentee.id }, data: { publicProfile: true } });
  try {
    await signInAsTenantActor(page, orgB.mentee);
    expect((await page.request.get(`/api/avatar/${orgA.mentee.id}`)).status()).toBe(200);
  } finally {
    await prisma.user.update({ where: { id: orgA.mentee.id }, data: { publicProfile: false } });
  }
});
