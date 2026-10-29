import { test, expect } from '@playwright/test';
import { createHash, randomBytes } from 'crypto';
import { prisma, setOrgFeature } from './helpers/db';
import { seedTwoTenants, type TwoTenants } from './helpers/tenants';
import { strictValidate } from './helpers/strictSchema';

// /api/v1 responses against the published schema (#1611).
//
// /api/v1/openapi.json is a promise to integrators, and nothing compared it
// with what the routes actually send: a renamed field shipped green, and so
// did a new one nobody documented (an integrator starts relying on it, and it
// is then a contract nobody knows exists). This walks EVERY GET operation in
// the served document, fetches it with a key holding every scope, and checks
// the body against that operation's own 200 schema — strictly: required keys
// present and typed, and no key that the schema does not list
// (helpers/strictSchema.ts).
//
// Shape only. Which rows a key sees is the read-breadth spec's business
// (api-v1-read-breadth.spec.ts) and the tenant-scoping issues'.
//
// A contract break is not "fix the test": it is a documented field, or a
// version. docs/testing.md § Published contracts.

type Spec = { paths: Record<string, Record<string, any>>; 'x-api-key-scopes': { scopes: string[] } } & Record<string, any>;

let tenants: TwoTenants;
let headers: Record<string, string>;
let spec: Spec;
const seeded: Record<string, string> = {};

test.beforeAll(async ({ request }) => {
  spec = await (await request.get('/api/v1/openapi.json')).json();
  tenants = await seedTwoTenants();
  const t = tenants.orgA;
  await setOrgFeature(t.org.id, 'INTEGRATIONS_API', true);
  // One row of every resource the fixture does not already hold, so no list
  // is validated empty — an empty `data: []` conforms to anything.
  const interaction = await prisma.interactionLog.create({
    data: { relationId: t.relation.id, date: new Date(), type: 'Meeting', notes: 'contract note' },
  });
  const meeting = await prisma.meeting.create({
    data: { title: 'Contract meeting', relationId: t.relation.id, createdById: t.mentor.id, rsvpToken: `c-${randomBytes(8).toString('hex')}`, scheduledAt: new Date() },
  });
  const requisition = await prisma.requisition.create({
    data: { orgId: t.org.id, companyId: t.company.id, title: 'Contract role', status: 'OPEN', openings: 1, requiredSkills: ['TypeScript'] },
  });
  const interviewRequest = await prisma.interviewRequest.create({
    data: { orgId: t.org.id, companyId: t.company.id, requisitionId: requisition.id, menteeId: t.mentee.id },
  });
  Object.assign(seeded, {
    candidates: t.mentee.id,
    relationships: t.relation.id,
    interactions: interaction.id,
    meetings: meeting.id,
    companies: t.company.id,
    requisitions: requisition.id,
    offers: t.offer.id,
    'interview-requests': interviewRequest.id,
  });
  // Exactly the scopes the GET operations declare, plus read_notes so the
  // optional field it unlocks is validated too (the column cannot hold every
  // scope at once, and writes are not this spec's).
  const raw = `icrm_${randomBytes(24).toString('hex')}`;
  const key = await prisma.apiKey.create({
    data: {
      name: `e2e-v1-contract-shape-${randomBytes(4).toString('hex')}`,
      hashedKey: createHash('sha256').update(raw).digest('hex'),
      scopes: getScopes().join(','),
      orgId: t.org.id,
    },
  });
  headers = { authorization: `Bearer ${raw}` };
  // The key's own subscription, export and import, so /hooks and the two job
  // endpoints are validated against a real row too. Written directly: the
  // subscribe route's SSRF guard resolves the target (no DNS in a test), and
  // the exports and imports specs drive the jobs themselves.
  const hook = await prisma.webhook.create({
    data: { url: 'https://receiver.example/hook', secret: 'contract', events: ['mentorship.created'], orgId: t.org.id, apiKeyId: key.id, source: 'api' },
  });
  const day = 24 * 60 * 60 * 1000;
  const exp = await prisma.apiExport.create({
    data: { orgId: t.org.id, apiKeyId: key.id, resource: 'companies', expiresAt: new Date(Date.now() + day) },
  });
  const imp = await prisma.apiImport.create({
    data: { orgId: t.org.id, apiKeyId: key.id, kind: 'candidates', total: 1, input: '[]', expiresAt: new Date(Date.now() + day) },
  });
  Object.assign(seeded, { hooks: hook.id, exports: exp.id, imports: imp.id });
});

test.afterAll(async () => {
  const orgIds = tenants?.orgIds ?? [];
  await prisma.interviewRequest.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.requisition.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.apiKey.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.orgEntitlement.deleteMany({ where: { orgId: { in: orgIds } } });
  await tenants?.cleanup();
});

// Templated GET operations this spec cannot fill, each with why. Empty today:
// every GET in the document is exercised. A NEW templated path fails the
// loop below until it is seeded or listed here — never passed by silence.
const NOT_EXERCISED: Record<string, string> = {};

function getScopes(): string[] {
  const scopes = new Set<string>(['interactions:read_notes']);
  for (const item of Object.values(spec.paths)) {
    for (const req of item.get?.security ?? []) for (const sc of req.apiKey ?? []) scopes.add(sc);
  }
  return [...scopes].sort();
}

function okSchema(op: Record<string, any>) {
  const ok = op.responses?.['200'];
  const resolved = ok?.$ref ? ok.$ref.split('/').slice(1).reduce((n: any, k: string) => n?.[k], spec) : ok;
  return resolved?.content?.['application/json']?.schema;
}

test('every GET operation answers with exactly its published 200 schema — no missing and no undocumented field', {
  tag: '@smoke',
}, async ({ request }) => {
  const problems: string[] = [];
  const exercised: string[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    const op = item.get;
    if (!op || path in NOT_EXERCISED) continue;
    const schema = okSchema(op);
    expect(schema, `${path} documents no 200 application/json schema`).toBeTruthy();

    let url = `/api/v1${path}`;
    const idParam = path.match(/^\/([^/]+)\/\{id\}$/);
    if (idParam) {
      const id = seeded[idParam[1]];
      expect(id, `${path}: no seeded row — seed one or list it in NOT_EXERCISED with the reason`).toBeTruthy();
      url = `/api/v1/${idParam[1]}/${id}`;
    } else if (path.includes('{')) {
      throw new Error(`${path}: a templated GET this spec does not know how to fill — extend it or list it in NOT_EXERCISED`);
    }

    const res = await request.get(url, { headers });
    expect(res.status(), `${url}: ${await res.text()}`).toBe(200);
    const body = await res.json();
    // A list must carry the seeded row, or the item schema was checked against nothing.
    if (Array.isArray(body?.data)) expect(body.data.length, `${url} returned an empty list — nothing was validated`).toBeGreaterThan(0);
    problems.push(...strictValidate(body, schema, spec, url));
    exercised.push(path);
  }
  expect(problems, 'the response no longer matches /api/v1/openapi.json — document the field or ship a new version').toEqual([]);
  // The resources an integrator syncs are all among them (a guard on the guard).
  for (const r of ['candidates', 'relationships', 'interactions', 'meetings', 'companies', 'requisitions', 'offers', 'interview-requests']) {
    expect(exercised, `/${r} was not exercised`).toContain(`/${r}`);
    expect(exercised, `/${r}/{id} was not exercised`).toContain(`/${r}/{id}`);
  }
});

test('the webhook payloads are published for every subscribable event', { tag: '@smoke' }, async () => {
  const hooks = spec['x-webhooks'];
  const published = new Set(Object.keys(hooks.payloads).map((k: string) => k.replace(/@\d+$/, '')));
  for (const event of hooks.events as string[]) expect(published.has(event), `${event} has no published payload`).toBe(true);
  for (const entry of Object.values(hooks.payloads) as { schema: Record<string, unknown> }[]) {
    expect(entry.schema).toMatchObject({ type: 'object', additionalProperties: false });
  }
});
