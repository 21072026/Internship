// Unit tests for src/lib/meetingTenantRule.ts — which tenant a meeting (or a
// recurring rule) belongs to (#2542 follow-up).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// Meeting and MeetingSeries carry no orgId, so an admin of one tenant could
// list, move, cancel and end another tenant's meetings by id while
// MT_ENFORCE_ISOLATION is off. The by-id checks (src/lib/meetingAccess.ts)
// resolve the tenant through this rule; these tests pin its order and, above
// all, that a parent with a NULL org still decides (it is the default org's)
// instead of falling through to the creator.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { meetingOrgSource } = await import('../../src/lib/meetingTenantRule.ts');

test('a 1:1 meeting belongs to its relation\'s tenant', () => {
  assert.deepEqual(meetingOrgSource({ relation: { orgId: 'org-a' }, project: { orgId: 'org-b' } }), { orgId: 'org-a' });
});

test('a project room belongs to the project\'s tenant', () => {
  assert.deepEqual(meetingOrgSource({ relation: null, project: { orgId: 'org-b' } }), { orgId: 'org-b' });
});

test('a group chat meeting belongs to the conversation\'s project', () => {
  assert.deepEqual(
    meetingOrgSource({ relation: null, project: null, conversation: { project: { orgId: 'org-c' } } }),
    { orgId: 'org-c' },
  );
});

test('a parent with a NULL org decides (default org) — it never falls through to the creator', () => {
  assert.deepEqual(meetingOrgSource({ relation: { orgId: null } }), { orgId: null });
  assert.deepEqual(meetingOrgSource({ project: { orgId: null } }), { orgId: null });
});

test('no parent at all (DIRECT chat, instant room, orphaned series) → the creator decides', () => {
  assert.equal(meetingOrgSource({}), 'creator');
  assert.equal(meetingOrgSource({ relation: null, project: null, conversation: null }), 'creator');
  assert.equal(meetingOrgSource({ conversation: { project: null } }), 'creator');
});
