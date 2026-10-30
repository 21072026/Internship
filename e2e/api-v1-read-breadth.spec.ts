import { test, expect, type APIRequestContext } from '@playwright/test';
import { createHash, randomBytes } from 'crypto';
import { prisma, setOrgFeature } from './helpers/db';
import { seedTwoTenants, type SeededTenant, type TwoTenants } from './helpers/tenants';

// Read breadth of /api/v1 (#1990): relationships, interactions, meetings,
// companies, requisitions, offers and interview requests — each on the v1
// contract, each scoped to the key's organisation, each answering another
// tenant's id with the same 404 as a missing one. Plus the PII line: no
// resource carries an e-mail address, and an interaction's note body needs its
// own scope.
//
// API-only. Two symmetric tenants (helpers/tenants.ts), plus the rows that
// fixture does not seed: an interaction, a meeting, a requisition and an
// interview request per tenant, and a key per tenant.

const READ_SCOPES = 'relationships:read,interactions:read,meetings:read,companies:read,hiring:read';
const SECRET_NOTE = 'confidential mentoring note';

type Extra = { interaction: string; meeting: string; requisition: string; interviewRequest: string; headers: Record<string, string> };

async function mintKey(orgId: string, scopes: string) {
  const raw = `icrm_${randomBytes(24).toString('hex')}`;
  await prisma.apiKey.create({
    data: { name: `e2e-v1-breadth-${randomBytes(4).toString('hex')}`, hashedKey: createHash('sha256').update(raw).digest('hex'), scopes, orgId },
  });
  return { authorization: `Bearer ${raw}` };
}

async function seedExtra(t: SeededTenant): Promise<Extra> {
  await setOrgFeature(t.org.id, 'INTEGRATIONS_API', true);
  const interaction = await prisma.interactionLog.create({
    data: { relationId: t.relation.id, date: new Date(), type: 'Meeting', notes: `${SECRET_NOTE} ${t.label}` },
  });
  const meeting = await prisma.meeting.create({
    data: { title: `V1 ${t.label} meeting`, relationId: t.relation.id, createdById: t.mentor.id, rsvpToken: `v1-${randomBytes(8).toString('hex')}`, scheduledAt: new Date() },
  });
  const requisition = await prisma.requisition.create({
    data: { orgId: t.org.id, companyId: t.company.id, title: `V1 ${t.label} role`, status: 'OPEN', openings: 2, requiredSkills: ['TypeScript'] },
  });
  const interviewRequest = await prisma.interviewRequest.create({
    data: { orgId: t.org.id, companyId: t.company.id, requisitionId: requisition.id, menteeId: t.mentee.id },
  });
  return {
    interaction: interaction.id,
    meeting: meeting.id,
    requisition: requisition.id,
    interviewRequest: interviewRequest.id,
    headers: await mintKey(t.org.id, READ_SCOPES),
  };
}

let tenants: TwoTenants;
let a: Extra;
let b: Extra;

test.beforeAll(async () => {
  tenants = await seedTwoTenants();
  a = await seedExtra(tenants.orgA);
  b = await seedExtra(tenants.orgB);
});

test.afterAll(async () => {
  const orgIds = tenants?.orgIds ?? [];
  await prisma.interviewRequest.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.requisition.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.apiKey.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.orgEntitlement.deleteMany({ where: { orgId: { in: orgIds } } });
  await tenants?.cleanup();
});

function resources(t: SeededTenant, x: Extra) {
  return [
    { path: '/api/v1/relationships', id: t.relation.id },
    { path: '/api/v1/interactions', id: x.interaction },
    { path: '/api/v1/meetings', id: x.meeting },
    { path: '/api/v1/companies', id: t.company.id },
    { path: '/api/v1/requisitions', id: x.requisition },
    { path: '/api/v1/offers', id: t.offer.id },
    { path: '/api/v1/interview-requests', id: x.interviewRequest },
  ];
}

async function listIds(request: APIRequestContext, url: string, headers: Record<string, string>) {
  const res = await request.get(url, { headers });
  expect(res.status(), url).toBe(200);
  const body = await res.json();
  expect(body.page, url).toBeDefined();
  return { ids: (body.data as { id: string }[]).map((r) => r.id), text: JSON.stringify(body) };
}

test('every read resource sees its own organisation only, answers a foreign id 404, and carries no e-mail address', {
  tag: '@smoke',
}, async ({ request }) => {
  const { orgA, orgB } = tenants;
  const mine = resources(orgA, a);
  const theirs = resources(orgB, b);
  const emails = [orgA, orgB].flatMap((t) => t.actors.map((p) => p.email));

  for (let i = 0; i < mine.length; i++) {
    const { path, id } = mine[i];
    const foreign = theirs[i].id;

    const { ids, text } = await listIds(request, `${path}?limit=200`, a.headers);
    expect(ids, path).toContain(id);
    expect(ids, path).not.toContain(foreign);
    for (const email of emails) expect(text, `${path} leaks ${email}`).not.toContain(email);

    const one = await request.get(`${path}/${id}`, { headers: a.headers });
    expect(one.status(), `${path}/{id}`).toBe(200);
    expect((await one.json()).data.id).toBe(id);

    const cross = await request.get(`${path}/${foreign}`, { headers: a.headers });
    expect(cross.status(), `${path}/{foreign id}`).toBe(404);
    expect(await cross.json()).toMatchObject({ type: 'not_found' });
  }

  // A key without the resource's scope is refused, not served an empty list.
  const narrow = await mintKey(orgA.org.id, 'candidates:read');
  const refused = await request.get('/api/v1/relationships', { headers: narrow });
  expect(refused.status()).toBe(403);
  expect(await refused.json()).toMatchObject({ type: 'insufficient_scope' });
});

test('an interaction note body needs interactions:read_notes', { tag: '@smoke' }, async ({ request }) => {
  const without = await request.get(`/api/v1/interactions/${a.interaction}`, { headers: a.headers });
  expect(without.status()).toBe(200);
  const plain = (await without.json()).data;
  expect(plain.notes).toBeUndefined();
  expect(JSON.stringify(plain)).not.toContain(SECRET_NOTE);

  const notesKey = await mintKey(tenants.orgA.org.id, 'interactions:read,interactions:read_notes');
  const withNotes = await request.get(`/api/v1/interactions?relationId=${tenants.orgA.relation.id}`, { headers: notesKey });
  expect(withNotes.status()).toBe(200);
  const rows = (await withNotes.json()).data as { id: string; notes?: string }[];
  expect(rows.find((r) => r.id === a.interaction)?.notes).toBe(`${SECRET_NOTE} A`);
});

test('every resource family answers a delta fetch and validates its filters', async ({ request }) => {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  for (const { path, id } of resources(tenants.orgA, a)) {
    expect((await listIds(request, `${path}?updatedSince=${encodeURIComponent(since)}&limit=200`, a.headers)).ids, path).toContain(id);
    expect((await listIds(request, `${path}?updatedSince=${encodeURIComponent(future)}`, a.headers)).ids, path).toEqual([]);
  }

  // Filters narrow, and an unknown value is a 400 rather than an empty page.
  const active = await listIds(request, `/api/v1/relationships?status=ACTIVE&mentorId=${tenants.orgA.mentor.id}`, a.headers);
  expect(active.ids).toEqual([tenants.orgA.relation.id]);
  const bogus = await request.get('/api/v1/relationships?status=SOMETIMES', { headers: a.headers });
  expect(bogus.status()).toBe(400);
  expect((await bogus.json()).fields).toEqual([expect.objectContaining({ field: 'status' })]);

  const open = await listIds(request, '/api/v1/requisitions?status=OPEN', a.headers);
  expect(open.ids).toContain(a.requisition);
  const company = (await (await request.get(`/api/v1/companies/${tenants.orgA.company.id}`, { headers: a.headers })).json()).data;
  expect(company.openRequisitionCount).toBe(1);
});

test('a candidate is found by exact e-mail, in the key\'s organisation only, and the address is never returned', async ({ request }) => {
  // The lookup a connector's search step makes before it creates (#2004).
  const { orgA, orgB } = tenants;
  const key = await mintKey(orgA.org.id, 'candidates:read');
  const own = await listIds(request, `/api/v1/candidates?email=${encodeURIComponent(orgA.mentee.email.toUpperCase())}`, key);
  expect(own.ids).toEqual([orgA.mentee.id]);
  expect(own.text).not.toContain(orgA.mentee.email);
  // Another organisation's address finds nothing; an unknown one finds nothing.
  expect((await listIds(request, `/api/v1/candidates?email=${encodeURIComponent(orgB.mentee.email)}`, key)).ids).toEqual([]);
  expect((await listIds(request, '/api/v1/candidates?email=nobody%40example.test', key)).ids).toEqual([]);
});
