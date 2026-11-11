import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #3592: a session reaches a library guide only in its relation's own org. The
// three paths that take a template id — create, carry-over and the AI proposal
// — used to read the guide by id and check the org in JS (or, on carry-over,
// not at all): a default-org relation accepted every org's guide. The org is
// now in the WHERE (`agendaTemplateWhere`). A NULL-org guide is the default
// org's library (src/lib/tenantFilter.ts), not a global one: the default org
// keeps it, another org gets the 404 an unknown id gets.

const PASSWORD = 'Pass1234!';

test('a guide of another org is a missing one on every path that takes a template id', { tag: '@smoke' }, async ({ playwright }) => {
  const stamp = `${Date.now()}`;
  const emails = {
    mentor: uniqueEmail('agt-mentor'),
    mentee: uniqueEmail('agt-mentee'),
    mentorB: uniqueEmail('agt-mentor-b'),
    menteeB: uniqueEmail('agt-mentee-b'),
  };
  const orgB = await prisma.organization.create({
    data: { name: `AGT Other ${stamp}`, slug: `agt-other-${stamp}`, vertical: 'INTERNSHIP' },
  });
  // A default-org pair (NULL org on the relation, the legacy shape) …
  const mentor = await seedUser(emails.mentor, PASSWORD, 'MENTOR', 'AGT Mentor');
  const mentee = await seedUser(emails.mentee, PASSWORD, 'MENTEE', 'AGT Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' } });
  // … and a pair of org B.
  const mentorB = await seedUser(emails.mentorB, PASSWORD, 'MENTOR', 'AGT Mentor B', orgB.id);
  const menteeB = await seedUser(emails.menteeB, PASSWORD, 'MENTEE', 'AGT Mentee B', orgB.id);
  const relB = await prisma.mentorshipRelation.create({
    data: { orgId: orgB.id, mentorId: mentorB.id, menteeId: menteeB.id, status: 'ACTIVE' },
  });
  const guide = (title: string, orgId: string | null) =>
    prisma.agendaTemplate.create({
      data: { orgId, title: `${title} ${stamp}`, items: { create: [{ order: 0, prompt: `${title} prompt ${stamp}` }] } },
    });
  const foreignGuide = await guide('AGT B guide', orgB.id);
  const legacyGuide = await guide('AGT legacy guide', null);

  const asMentor = await playwright.request.newContext();
  const asMentorB = await playwright.request.newContext();
  try {
    expect((await signInViaApi(asMentor, emails.mentor, PASSWORD)).ok).toBeTruthy();
    expect((await signInViaApi(asMentorB, emails.mentorB, PASSWORD)).ok).toBeTruthy();

    // Create: org B's guide on a default-org relation — the hole this closes.
    const create = await asMentor.post('/api/agendas', { data: { relationId: rel.id, templateId: foreignGuide.id } });
    expect(create.status()).toBe(404);
    expect(await create.text()).not.toContain(foreignGuide.title);

    // The legacy NULL-org guide is the default org's: its own relation keeps it…
    const own = await asMentor.post('/api/agendas', { data: { relationId: rel.id, templateId: legacyGuide.id } });
    expect(own.status(), await own.text()).toBe(201);
    const agendaId = (await own.json()).agenda.id as string;
    // …and org B does not get it.
    const legacyForB = await asMentorB.post('/api/agendas', { data: { relationId: relB.id, templateId: legacyGuide.id } });
    expect(legacyForB.status()).toBe(404);

    // Carry-over used to instantiate any guide by id, with no org check at all.
    const carry = await asMentor.post(`/api/agendas/${agendaId}/carry-over`, { data: { templateId: foreignGuide.id } });
    expect(carry.status()).toBe(404);

    // The AI proposal reads the guide the same way (before any provider call).
    const blank = await asMentor.post('/api/agendas', { data: { relationId: rel.id } });
    expect(blank.status()).toBe(201);
    const blankId = (await blank.json()).agenda.id as string;
    const personalize = await asMentor.post('/api/agendas/personalize', { data: { agendaId: blankId, templateId: foreignGuide.id } });
    expect(personalize.status()).toBe(404);
    expect(await personalize.text()).not.toContain(foreignGuide.title);

    // Nothing anywhere was built from org B's guide.
    expect(await prisma.sessionAgenda.count({ where: { templateId: foreignGuide.id } })).toBe(0);
  } finally {
    await asMentor.dispose();
    await asMentorB.dispose();
    await prisma.sessionAgenda.deleteMany({ where: { relationId: { in: [rel.id, relB.id] } } });
    await prisma.agendaTemplate.deleteMany({ where: { id: { in: [foreignGuide.id, legacyGuide.id] } } });
    for (const e of Object.values(emails)) await cleanupByEmail(e);
    await prisma.organization.delete({ where: { id: orgB.id } }).catch(() => {});
  }
});
