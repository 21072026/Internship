import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSites, judge, stripComments } from '../check-authz.mjs';

// scripts/check-authz.mjs (#1571) is a scanner, so both of its failure modes
// are pinned on fixture strings: missing a hand-rolled admin check (the gate
// passes a route that bypasses the permission layer) and counting one that is
// not there (a comment, another user's role).

const count = (src) => findSites(src).length;

test('every shape of "is the caller an admin?" is counted', () => {
  assert.equal(count(`if (session.user.role !== 'ADMIN') return forbidden;`), 1);
  assert.equal(count(`if (!session || session?.user?.role === "ADMIN") {}`), 1);
  assert.equal(count(`const isAdmin = role === 'ADMIN';`), 1);
  assert.equal(count(`if ('ADMIN' !== session.user.role) {}`), 1);
  assert.equal(count(`if (!['MENTOR', 'ADMIN'].includes(session.user.role)) {}`), 1);
  assert.equal(count(`if (!['ADMIN'].includes(role)) {}`), 1);
  assert.equal(count(`async function requireAdmin() {}`), 1);
  assert.equal(count(`async function requireAdminOrg(id) {}`), 1);
  assert.equal(count(`const requireAdmin = async () => {};`), 1);
  assert.equal(count(`if (role !== 'ADMIN' && role !== 'MENTOR') {}`), 1);
});

test("another user's role is data, not the caller's authority", () => {
  assert.equal(count(`if (target.role === 'ADMIN') return conflict;`), 0);
  assert.equal(count(`const admins = users.filter((u) => u.role === 'ADMIN');`), 0);
  assert.equal(count(`where: { role: 'ADMIN' }`), 0);
  assert.equal(count(`if (!['MENTOR', 'MENTEE'].includes(session.user.role)) {}`), 0);
  assert.equal(count(`const gate = await requirePermission('user.write', { request });`), 0);
});

test('comments are not code, strings that look like comments are', () => {
  assert.equal(count(`// used to be: session.user.role !== 'ADMIN'\nconst x = 1;`), 0);
  assert.equal(count(`/* role === 'ADMIN' */ const x = 1;`), 0);
  assert.equal(count(`const u = 'https://x.example'; if (role === 'ADMIN') {}`), 1);
  assert.equal(stripComments('a // b\nc').split('\n').length, 2);
});

test('the line number survives a stripped block comment', () => {
  const src = `/*\n one\n two\n*/\nif (session.user.role !== 'ADMIN') {}`;
  assert.deepEqual(findSites(src).map((s) => s.line), [5]);
});

test('the ratchet: unlisted and grown fail, shrunk asks to lower, zero asks to delete', () => {
  const base = { pending: { 'a.ts': 2, 'b.ts': 1 }, allowed: {} };
  assert.deepEqual(judge({ 'a.ts': 2, 'b.ts': 1 }, base).problems, []);
  assert.match(judge({ 'a.ts': 2, 'b.ts': 1, 'c.ts': 1 }, base).problems[0], /^c\.ts: .*requirePermission/);
  assert.match(judge({ 'a.ts': 3, 'b.ts': 1 }, base).problems[0], /^a\.ts: 3 .*2 allowed/);
  assert.match(judge({ 'a.ts': 1, 'b.ts': 1 }, base).problems[0], /^a\.ts: .*lower it/);
  const gone = judge({ 'a.ts': 2 }, base);
  assert.match(gone.problems[0], /^b\.ts: 0 /);
  assert.deepEqual(gone.shrunk, { 'a.ts': 2 });
});

test('--shrink never raises a number', () => {
  const { shrunk } = judge({ 'a.ts': 5 }, { pending: { 'a.ts': 2 } });
  assert.equal(shrunk['a.ts'], 2);
});

test('an allowed site needs its reason, and is part of the budget', () => {
  const ok = { pending: {}, allowed: { 'a.ts': { count: 1, reason: 'data shape: admins see every row' } } };
  assert.deepEqual(judge({ 'a.ts': 1 }, ok).problems, []);
  const bare = { pending: {}, allowed: { 'a.ts': { count: 1, reason: ' ' } } };
  assert.match(judge({ 'a.ts': 1 }, bare).problems[0], /needs an integer count and a reason/);
});
