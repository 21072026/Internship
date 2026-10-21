import { test, expect } from '@playwright/test';
import { createHash, randomBytes } from 'crypto';
import { prisma, setOrgFeature } from './helpers/db';
import { seedTwoTenants, type TwoTenants } from './helpers/tenants';

// The /api/v1 writes (#1996): candidates, a relationship's stage and an
// interaction — each through the same domain write path the app uses, on the
// write floor of #1994 (scope, Idempotency-Key, 422 contract, activity row).
//
// API-only. Two symmetric tenants (helpers/tenants.ts): A's key writes, B's
// rows prove nothing crosses the org line.

const EMAIL_DOMAIN = 'v1-writes.example';
const WRITE_SCOPES = 'candidates:read,candidates:write,relationships:read,relationships:write,interactions:write';

async function mintKey(orgId: string, scopes: string) {
  const raw = `icrm_${randomBytes(24).toString('hex')}`;
  const key = await prisma.apiKey.create({
    data: { name: `e2e-v1-writes-${randomBytes(4).toString('hex')}`, hashedKey: createHash('sha256').update(raw).digest('hex'), scopes, orgId },
  });
  return { id: key.id, headers: { authorization: `Bearer ${raw}` } };
}

let tenants: TwoTenants;
let keyA: { id: string; headers: Record<string, string> };
let keyB: { id: string; headers: Record<string, string> };

test.beforeAll(async () => {
  tenants = await seedTwoTenants();
  for (const t of [tenants.orgA, tenants.orgB]) await setOrgFeature(t.org.id, 'INTEGRATIONS_API', true);
  keyA = await mintKey(tenants.orgA.org.id, WRITE_SCOPES);
  keyB = await mintKey(tenants.orgB.org.id, WRITE_SCOPES);
});

test.afterAll(async () => {
  const orgIds = tenants?.orgIds ?? [];
  const relationIds = [tenants?.orgA.relation.id, tenants?.orgB.relation.id].filter(Boolean) as string[];
  const menteeIds = [tenants?.orgA.mentee.id, tenants?.orgB.mentee.id].filter(Boolean) as string[];
  await prisma.statusChange.deleteMany({ where: { relationId: { in: relationIds } } });
  await prisma.interactionLog.deleteMany({ where: { relationId: { in: relationIds } } });
  await prisma.notification.deleteMany({ where: { userId: { in: menteeIds } } });
  await prisma.activityLog.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.stageSla.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${EMAIL_DOMAIN}` } } });
  await prisma.apiKey.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.orgEntitlement.deleteMany({ where: { orgId: { in: orgIds } } });
  await tenants?.cleanup();
});

test('a stage moved through the API has the board’s effects, and every refusal comes before the write', {
  tag: '@smoke',
}, async ({ request }) => {
  const { orgA, orgB } = tenants;
  const url = `/api/v1/relationships/${orgA.relation.id}/stage`;
  await prisma.stageSla.create({ data: { orgId: orgA.org.id, stageKey: 'INTERNSHIP_COMPLETED_490', days: 10 } });

  // Refusals: no write scope, another tenant's relationship, an unknown key
  // (a LABEL is not a key), an off-path stage without a reason.
  const readOnly = await mintKey(orgA.org.id, 'relationships:read');
  expect((await request.patch(url, { headers: readOnly.headers, data: { stage: 'INTERNSHIP_COMPLETED_490' } })).status()).toBe(403);
  expect((await request.patch(`/api/v1/relationships/${orgB.relation.id}/stage`, { headers: keyA.headers, data: { stage: 'INTERNSHIP_COMPLETED_490' } })).status()).toBe(404);
  const unknown = await request.patch(url, { headers: keyA.headers, data: { stage: 'Staj Tamamlandı' } });
  expect(unknown.status()).toBe(422);
  expect((await unknown.json()).errors).toEqual([expect.objectContaining({ path: 'stage', code: 'unknown_stage' })]);
  const dropped = await request.patch(url, { headers: keyA.headers, data: { stage: 'INTERNSHIP_DROPPED_460' } });
  expect(dropped.status()).toBe(422);
  expect((await dropped.json()).errors).toEqual([expect.objectContaining({ path: 'reasonCode' })]);
  expect(await prisma.statusChange.count({ where: { relationId: orgA.relation.id } })).toBe(0);

  // The stage it already has: a 200 no-op, no history.
  const same = await request.patch(url, { headers: keyA.headers, data: { stage: 'INTERNSHIP_IN_PROGRESS_450' } });
  expect(same.status()).toBe(200);
  expect(await same.json()).toMatchObject({ changed: false, data: { pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450' } });

  // The move — and everything the board's move leaves behind.
  const before = new Date();
  const moved = await request.patch(url, { headers: { ...keyA.headers, 'idempotency-key': `stage-${Date.now()}` }, data: { stage: 'INTERNSHIP_COMPLETED_490' } });
  expect(moved.status()).toBe(200);
  expect(await moved.json()).toMatchObject({ changed: true, data: { id: orgA.relation.id, pipelineStatus: 'INTERNSHIP_COMPLETED_490' } });

  const rel = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: orgA.relation.id } });
  expect(rel.pipelineStatus).toBe('INTERNSHIP_COMPLETED_490');
  expect(rel.stageDeadline!.getTime()).toBeGreaterThan(before.getTime() + 9 * 86_400_000); // the stage SLA
  const history = await prisma.statusChange.findMany({ where: { relationId: orgA.relation.id } });
  expect(history).toEqual([expect.objectContaining({ fromStatus: 'INTERNSHIP_IN_PROGRESS_450', toStatus: 'INTERNSHIP_COMPLETED_490', changedById: null })]);
  const domain = await prisma.activityLog.findFirst({ where: { action: 'pipeline.stage_change', targetId: orgA.relation.id } });
  expect(domain?.detail).toContain(`api key ${keyA.id}`);
  expect(await prisma.notification.count({ where: { userId: orgA.mentee.id, createdAt: { gte: before } } })).toBeGreaterThan(0);
  const api = await prisma.activityLog.findFirst({ where: { action: 'api.relationship.stage', targetId: orgA.relation.id } });
  expect(api?.detail).toContain(`api key ${keyA.id}`);

  // A finished relationship's stage is history: 409 with the current stage.
  await prisma.mentorshipRelation.update({ where: { id: orgA.relation.id }, data: { status: 'COMPLETED' } });
  try {
    const closed = await request.patch(url, { headers: keyA.headers, data: { stage: 'JOB_SEEKING_500' } });
    expect(closed.status()).toBe(409);
    expect(await closed.json()).toMatchObject({ type: 'invalid_transition', currentStage: 'INTERNSHIP_COMPLETED_490' });
  } finally {
    await prisma.mentorshipRelation.update({ where: { id: orgA.relation.id }, data: { status: 'ACTIVE' } });
  }
  expect(await prisma.statusChange.count({ where: { relationId: orgA.relation.id } })).toBe(1);
});

test('POST /candidates refuses duplicates, is idempotent, stays in its org; PATCH refuses forbidden fields', {
  tag: '@smoke',
}, async ({ request }) => {
  const { orgA } = tenants;
  const stamp = Date.now();
  const email = `ada-${stamp}@${EMAIL_DOMAIN}`;
  const body = { fullName: `Ada Lovelace ${stamp}`, email, university: `Analytical University ${stamp}`, skills: ['Mathematics', 'Engines'] };
  const idem = `cand-${stamp}`;

  const created = await request.post('/api/v1/candidates', { headers: { ...keyA.headers, 'idempotency-key': idem }, data: body });
  expect(created.status()).toBe(201);
  const candidate = (await created.json()).data;
  expect(candidate).toMatchObject({ fullName: body.fullName, university: body.university, skills: ['Mathematics', 'Engines'] });
  expect(candidate.email).toBeUndefined();

  // A retry of the same request replays, and creates nothing.
  const replay = await request.post('/api/v1/candidates', { headers: { ...keyA.headers, 'idempotency-key': idem }, data: body });
  expect(replay.status()).toBe(201);
  expect(replay.headers()['idempotent-replayed']).toBe('true');
  expect((await replay.json()).data.id).toBe(candidate.id);
  expect(await prisma.user.count({ where: { email } })).toBe(1);

  // In A's org, as a MENTEE, and invisible to B's key.
  const row = await prisma.user.findUniqueOrThrow({ where: { id: candidate.id }, select: { orgId: true, role: true } });
  expect(row).toEqual({ orgId: orgA.org.id, role: 'MENTEE' });
  expect((await request.get(`/api/v1/candidates/${candidate.id}`, { headers: keyA.headers })).status()).toBe(200);
  expect((await request.get(`/api/v1/candidates/${candidate.id}`, { headers: keyB.headers })).status()).toBe(404);
  expect((await request.patch(`/api/v1/candidates/${candidate.id}`, { headers: keyB.headers, data: { department: 'X' } })).status()).toBe(404);

  // The same address: always a duplicate, with the id of A's own account.
  const again = await request.post('/api/v1/candidates', { headers: keyA.headers, data: { ...body, fullName: 'Someone Else' } });
  expect(again.status()).toBe(409);
  expect(await again.json()).toMatchObject({ type: 'duplicate_candidate', matches: [{ id: candidate.id, signals: ['email'] }] });

  // A look-alike (same name, new address): 409 with the match, unless the caller insists.
  const lookalike = { ...body, email: `ada2-${stamp}@${EMAIL_DOMAIN}` };
  const similar = await request.post('/api/v1/candidates', { headers: keyA.headers, data: lookalike });
  expect(similar.status()).toBe(409);
  expect((await similar.json()).matches[0].id).toBe(candidate.id);
  expect((await request.post('/api/v1/candidates', { headers: keyA.headers, data: { ...lookalike, allowPossibleDuplicate: true } })).status()).toBe(201);

  // PATCH: role, orgId, email and credentials are refused by name — never ignored.
  for (const forbidden of [{ role: 'ADMIN' }, { orgId: tenants.orgB.org.id }, { email: 'x@example.test' }, { password: 'hunter2' }]) {
    const res = await request.patch(`/api/v1/candidates/${candidate.id}`, { headers: keyA.headers, data: { department: 'Engines', ...forbidden } });
    expect(res.status(), JSON.stringify(forbidden)).toBe(422);
    expect((await res.json()).errors).toEqual([expect.objectContaining({ code: 'unrecognized_keys' })]);
  }
  expect(await prisma.user.findUniqueOrThrow({ where: { id: candidate.id }, select: { role: true, orgId: true, department: true } }))
    .toEqual({ role: 'MENTEE', orgId: orgA.org.id, department: null });

  const patched = await request.patch(`/api/v1/candidates/${candidate.id}`, { headers: keyA.headers, data: { department: 'Engines', graduationYear: 1843 } });
  expect(patched.status()).toBe(422); // out of range
  const ok = await request.patch(`/api/v1/candidates/${candidate.id}`, { headers: keyA.headers, data: { department: 'Engines', graduationYear: 2027 } });
  expect(ok.status()).toBe(200);
  expect((await ok.json()).data).toMatchObject({ department: 'Engines', graduationYear: 2027 });
  expect(await prisma.activityLog.count({ where: { action: 'api.candidate.update', targetId: candidate.id } })).toBe(1);
});

test('POST /interactions logs through the app’s write path, in the key’s org only', async ({ request }) => {
  const { orgA, orgB } = tenants;
  const data = { relationId: orgA.relation.id, type: 'Call', date: new Date().toISOString(), notes: 'Talked about the internship plan.' };
  const before = new Date();

  expect((await request.post('/api/v1/interactions', { headers: keyA.headers, data: { ...data, relationId: orgB.relation.id } })).status()).toBe(404);
  const bad = await request.post('/api/v1/interactions', { headers: keyA.headers, data: { ...data, type: 'Carrier pigeon' } });
  expect(bad.status()).toBe(422);
  expect((await bad.json()).errors[0].path).toBe('type');

  const res = await request.post('/api/v1/interactions', { headers: keyA.headers, data });
  expect(res.status()).toBe(201);
  const created = (await res.json()).data;
  expect(created).toMatchObject({ relationId: orgA.relation.id, type: 'Call' });
  expect(created.notes).toBeUndefined(); // writing a note is not reading notes

  const rows = await prisma.interactionLog.findMany({ where: { relationId: orgA.relation.id } });
  expect(rows.map((r) => r.id)).toEqual([created.id]);
  expect(rows[0].notes).toBe(data.notes);
  expect(await prisma.notification.count({ where: { userId: orgA.mentee.id, createdAt: { gte: before } } })).toBeGreaterThan(0);
  expect(await prisma.activityLog.count({ where: { action: 'api.interaction.create', targetId: created.id } })).toBe(1);
});
