import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// Vertical write-path gate (#2352, epic #2348). Hiding a module from the nav
// (#2351) is not access control — the route is still reachable by a direct POST.
// A mutating handler for a mentorship-specific module now calls
// requireCapability() first, so a MARKETING org (no mentorship/evaluations/
// projects/placements module) is refused with 403 code:capability_unavailable,
// whatever the role.
// INTERNSHIP carries every capability, so every handler behaves as before —
// asserted by the INTERNSHIP case landing on a normal validation path, not a 403.

test.afterAll(async () => {
  await prisma.$disconnect();
});

// (path, capability the module needs) — one representative per gated module.
const GATED = [
  { path: '/api/goals', cap: 'mentorship' },
  { path: '/api/weekly-reports', cap: 'mentorship' },
  { path: '/api/questions', cap: 'mentorship' },
  { path: '/api/meeting-requests', cap: 'mentorship' },
  { path: '/api/evaluations', cap: 'evaluations' },
  // A second Evaluation writer: panel scoring. Gated on 'evaluations' too, so
  // /api/evaluations is not closed while this stays open (review of #2363). The
  // gate runs before the panel lookup, so a dummy id still reaches it.
  { path: '/api/interview-panels/00000000-0000-0000-0000-000000000000/score', cap: 'evaluations' },
  // Intern projects (#2502): MARKETING dropped 'projects', so the static POST,
  // the id-bearing writers (their gate runs before the project lookup, so a
  // dummy id still reaches it) and meeting-series (gate at the handler top) are
  // all refused. The body-conditional gates — invite/conversations/instant with
  // a projectId, note→task conversion, a project-bound contributor-terms
  // acceptance — need a valid body and are not representable in this
  // empty-POST table; they are covered by the same requireCapability call.
  // One body-conditional gate does NOT ride on that call and has its own test
  // at the bottom of this file: an instant meeting started from a project's
  // group chat names the room, not the project, so it is gated on the room's
  // owning project after the context resolves (#2504).
  { path: '/api/projects', cap: 'projects' },
  { path: '/api/projects/00000000-0000-0000-0000-000000000000/members', cap: 'projects' },
  { path: '/api/projects/00000000-0000-0000-0000-000000000000/join-requests', cap: 'projects' },
  { path: '/api/projects/00000000-0000-0000-0000-000000000000/task-templates', cap: 'projects' },
  { path: '/api/projects/00000000-0000-0000-0000-000000000000/tasks', cap: 'projects' },
  { path: '/api/meeting-series', cap: 'projects' },
  // Placements (#2364): offers, requisitions, interview requests and panel
  // creation/roster/lifecycle. MARKETING does not carry 'placements', so every
  // mutating handler refuses BEFORE its own role check — which is why the
  // COMPANY-only interview-request POST still answers capability_unavailable to
  // this admin. The id-bearing gates run before the row lookup, so a dummy id
  // reaches them; PATCH handlers are exercised with their real method. An admin
  // passes every handler's role check, so this table cannot actually see the
  // gate/role ORDER — the mentee test further down is what pins it.
  { path: '/api/offers', cap: 'placements' },
  { path: '/api/offers/00000000-0000-0000-0000-000000000000', cap: 'placements', method: 'PATCH' },
  { path: '/api/requisitions', cap: 'placements' },
  { path: '/api/requisitions/00000000-0000-0000-0000-000000000000', cap: 'placements', method: 'PATCH' },
  { path: '/api/interview-requests', cap: 'placements' },
  { path: '/api/interview-requests/00000000-0000-0000-0000-000000000000', cap: 'placements', method: 'PATCH' },
  { path: '/api/interview-panels', cap: 'placements' },
  { path: '/api/interview-panels/00000000-0000-0000-0000-000000000000', cap: 'placements', method: 'PATCH' },
  { path: '/api/interview-panels/00000000-0000-0000-0000-000000000000/close', cap: 'placements' },
  { path: '/api/interview-panels/00000000-0000-0000-0000-000000000000/reopen', cap: 'placements' },
];

async function adminIn(vertical: 'INTERNSHIP' | 'MARKETING') {
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const org = await prisma.organization.create({
    data: { name: `WGate ${vertical} ${stamp}`, slug: `wgate-${stamp}`, vertical },
  });
  const email = uniqueEmail(`wgate-${vertical.toLowerCase()}`);
  const admin = await seedUser(email, 'WGatePass123', 'ADMIN', `${vertical} Admin`);
  await prisma.user.update({ where: { id: admin.id }, data: { orgId: org.id } });
  return { org, email };
}

// Both tests walk the whole table behind ONE sign-in — 22 round trips as of
// #2364, which is more than the 60s default allows against a local `next dev`
// server, where the first hit on each of those routes compiles it. CI builds
// the app (`npm run start`) and gets through the table in seconds; this keeps
// the local run from going red for a reason that has nothing to do with the
// gate. Splitting per capability would trade the timeout for four more
// sign-ins, which is the slower half of the test.
test('a MARKETING org is refused at every gated write path with capability_unavailable', async ({ page }) => {
  test.slow();
  const { org, email } = await adminIn('MARKETING');
  try {
    await signInAndSettle(page, email, 'WGatePass123', '/admin');
    for (const { path, method } of GATED) {
      // A deliberately empty body: the gate runs before validation, so a gated
      // vertical never even reaches the 400. Proves the gate is FIRST.
      const res = await page.request.fetch(path, { method: method ?? 'POST', data: {} });
      expect(res.status(), `${method ?? 'POST'} ${path} should be gated`).toBe(403);
      const body = await res.json();
      expect(body.code, `${path} body.code`).toBe('capability_unavailable');
    }
  } finally {
    await cleanupByEmail(email);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});

test('an INTERNSHIP org is NOT gated — the same posts pass the capability check', async ({ page }) => {
  test.slow();
  const { org, email } = await adminIn('INTERNSHIP');
  try {
    await signInAndSettle(page, email, 'WGatePass123', '/admin');
    for (const { path, method } of GATED) {
      const res = await page.request.fetch(path, { method: method ?? 'POST', data: {} });
      // INTERNSHIP carries every capability, so the gate is a no-op: the empty
      // body falls through to the handler's own validation/authorization, which
      // is anything BUT capability_unavailable (400 validation, 403 role, etc.).
      const body = await res.json().catch(() => ({}));
      expect(body.code, `${path} must not be capability-gated for INTERNSHIP`).not.toBe('capability_unavailable');
    }
  } finally {
    await cleanupByEmail(email);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});

// The handlers of the module whose OWN role check would answer first if the gate
// sat behind it: both requisitions routes (ADMIN|COMPANY, via authScope) and the
// two panel handlers whose session check used to be fused with a role check. The
// admin table above cannot see the difference, because an admin passes every one
// of those role checks. A MENTEE passes none of them, so this is where "gate
// before the role check" is actually observable: without it the same MARKETING
// tenant would hear `forbidden`/401 here and `capability_unavailable` on
// /api/offers — one module telling two different stories about whether it exists.
const ROLE_CHECKED: { path: string; method?: string }[] = [
  { path: '/api/requisitions' },
  { path: '/api/requisitions/00000000-0000-0000-0000-000000000000', method: 'PATCH' },
  { path: '/api/interview-panels' },
  { path: '/api/interview-panels/00000000-0000-0000-0000-000000000000/close' },
];

async function menteeInMarketing() {
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const org = await prisma.organization.create({
    data: { name: `WGate MARKETING mentee ${stamp}`, slug: `wgate-mentee-${stamp}`, vertical: 'MARKETING' },
  });
  const email = uniqueEmail('wgate-marketing-mentee');
  const mentee = await seedUser(email, 'WGatePass123', 'MENTEE', 'MARKETING Mentee');
  await prisma.user.update({ where: { id: mentee.id }, data: { orgId: org.id } });
  return { org, email };
}

// Neither shared sign-in helper fits this user. `signInAndSettle` waits for the
// account-menu button, and this mentee never reaches a page that has one: the
// mentee portal is itself a mentorship-vertical shell (#2351), so a MARKETING
// mentee is bounced from '/portal' to the bare '/account' settings page.
// `signInAsFreshUser` waits for that URL with `waitForURL`'s default
// `waitUntil: 'load'`, which '/account' does not reach inside the budget under
// `next dev`. Nothing here clicks anything — every assertion is an API call —
// so the only thing worth waiting for is the session cookie itself.
async function signInForApiCalls(page: Page, email: string, password: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await expect
    .poll(async () => (await (await page.request.get('/api/auth/session')).json())?.user?.email ?? null, {
      timeout: 45_000,
    })
    .toBe(email);
}

test('a MARKETING mentee is refused by the capability gate, not by the handler role check', async ({ page }) => {
  test.slow();
  const { org, email } = await menteeInMarketing();
  try {
    await signInForApiCalls(page, email, 'WGatePass123');
    for (const { path, method } of ROLE_CHECKED) {
      const res = await page.request.fetch(path, { method: method ?? 'POST', data: {} });
      expect(res.status(), `${method ?? 'POST'} ${path} should answer the capability gate`).toBe(403);
      const body = await res.json();
      expect(body.code, `${path} body.code`).toBe('capability_unavailable');
    }
  } finally {
    await cleanupByEmail(email);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});

/**
 * A project's group room, with its admin as member and participant — the setup
 * both halves of the #2504 case need. Returns the ids to clean up.
 */
async function projectRoomFor(orgId: string, email: string) {
  const admin = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  const project = await prisma.project.create({
    data: {
      orgId,
      name: `WGate Room Project ${Date.now()}`,
      ownerType: 'MENTOR',
      ownerUserId: admin.id,
      members: { create: [{ userId: admin.id, role: 'OWNER' }] },
    },
  });
  const conversation = await prisma.conversation.create({
    data: {
      type: 'GROUP',
      projectId: project.id,
      participants: { create: [{ userId: admin.id }] },
    },
  });
  return { adminId: admin.id, projectId: project.id, conversationId: conversation.id };
}

async function cleanupProjectRoom(room: { adminId: string; projectId: string; conversationId: string }) {
  await prisma.meeting.deleteMany({ where: { conversationId: room.conversationId } });
  await prisma.message.deleteMany({ where: { conversationId: room.conversationId } });
  await prisma.notification.deleteMany({ where: { userId: room.adminId } });
  await prisma.conversationParticipant.deleteMany({ where: { conversationId: room.conversationId } });
  await prisma.conversation.deleteMany({ where: { id: room.conversationId } });
  await prisma.projectMember.deleteMany({ where: { projectId: room.projectId } });
  await prisma.project.deleteMany({ where: { id: room.projectId } });
}

// #2504 — the gate reads the BODY, and a call started from a project's group
// chat carries `conversationId` and no `projectId`, so it used to sail past a
// gate that was looking for the wrong key. Creating that same room through
// `POST /api/conversations` has always been gated, so the module was closed for
// making the room and open for holding a call in it.
test('a MARKETING org cannot start a call in a project group room', async ({ page }) => {
  const { org, email } = await adminIn('MARKETING');
  const room = await projectRoomFor(org.id, email);
  try {
    await signInAndSettle(page, email, 'WGatePass123', '/admin');

    const res = await page.request.post('/api/meetings/instant', {
      data: { conversationId: room.conversationId, title: 'Standup' },
    });
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe('capability_unavailable');

    // Refused before anything was written — no room booked, and no "started a
    // meeting" line dropped into the chat.
    expect(await prisma.meeting.count({ where: { conversationId: room.conversationId } })).toBe(0);
    expect(await prisma.message.count({ where: { conversationId: room.conversationId } })).toBe(0);
  } finally {
    await cleanupProjectRoom(room);
    await cleanupByEmail(email);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});

// The other direction matters just as much: the new gate must not close a door
// that is supposed to be open. INTERNSHIP carries 'projects', so the identical
// request goes through and the call is created.
test('an INTERNSHIP org still starts a call in a project group room', async ({ page }) => {
  const { org, email } = await adminIn('INTERNSHIP');
  const room = await projectRoomFor(org.id, email);
  try {
    await signInAndSettle(page, email, 'WGatePass123', '/admin');

    const res = await page.request.post('/api/meetings/instant', {
      data: { conversationId: room.conversationId, title: 'Standup' },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.meetLink).toBeTruthy();

    const meeting = await prisma.meeting.findUnique({ where: { id: body.meetingId } });
    expect(meeting?.conversationId).toBe(room.conversationId);
    // The meeting still hangs off exactly ONE context (#1051): the owning
    // project is what the gate reads, never what the row is written with.
    expect(meeting?.projectId).toBeNull();
  } finally {
    await cleanupProjectRoom(room);
    await cleanupByEmail(email);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});
