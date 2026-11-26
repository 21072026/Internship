import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, setOrgFeature } from './helpers/db';

// The feedback review's script end to end (#3939, scripts/feedback-review.mjs):
// against this app, with a synthetic org, synthetic reports and a review key.
// It lists the NEW reports masked, fetches a screenshot only once an admin
// shared it, writes the triage, and refuses to run without its key. SYNTHETIC ONLY.

const run = promisify(execFile);
const STAMP = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const ids: Record<string, string> = {};
let orgId = '';
let email = '';
let rawKey = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Review CLI ${STAMP}`, slug: `review-cli-${STAMP}`, vertical: 'INTERNSHIP' } })).id;
  await setOrgFeature(orgId, 'INTEGRATIONS_API', true);
  email = uniqueEmail('review-cli');
  const user = await seedUser(email, 'ReviewCli123!', 'MENTOR', `Reporter ${STAMP}`, orgId);
  for (const [label, shot] of [['shot', true], ['plain', false]] as const) {
    ids[label] = (await prisma.supportReport.create({
      data: {
        orgId, userId: user.id, type: 'BUG',
        description: `The save button fails (${label}); write to someone-${STAMP}@acme.example`,
        url: 'https://app.example.test/sales/leads/x?token=secret', appVersion: 'e2e', env: 'test', userAgent: 'e2e', viewport: '1280x720',
        contactAllowed: false, context: { consoleErrors: [], failedRequests: [] },
        ...(shot ? { files: { create: { kind: 'SCREENSHOT', filename: 's.png', contentType: 'image/png', size: PNG.length, data: PNG } } } : {}),
      },
    })).id;
  }
  rawKey = `icrm_${randomBytes(24).toString('hex')}`;
  await prisma.apiKey.create({
    data: {
      name: `review-cli-${STAMP}`,
      hashedKey: createHash('sha256').update(rawKey).digest('hex'),
      scopes: 'support:read,support:read_shared_screenshots,support:triage',
      orgId,
    },
  });
});

test.afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.supportReport.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.apiKey.deleteMany({ where: { orgId } }).catch(() => {});
  await cleanupByEmail(email);
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

const cli = (baseURL: string | undefined, args: string[], key = rawKey) =>
  run('node', ['scripts/feedback-review.mjs', ...args], {
    env: { ...process.env, SUPPORT_REVIEW_API_KEY: key, SUPPORT_REVIEW_BASE_URL: baseURL ?? '' },
  });

test('without its key it stops, says what is missing and reads nothing', async ({ baseURL }) => {
  const err = await cli(baseURL, ['list'], '').catch((e) => e);
  expect(err.code).toBe(2);
  expect(err.stderr).toContain('SUPPORT_REVIEW_API_KEY');
});

test('list → screenshot only when shared → triage, end to end', async ({ baseURL }) => {
  test.slow();
  const { stdout } = await cli(baseURL, ['list']);
  const reports = JSON.parse(stdout) as { id: string; description: string; screenshotShared: boolean }[];
  expect(reports.map((r) => r.id).sort()).toEqual([ids.shot, ids.plain].sort());
  // Masked by the server: no address, no token.
  expect(stdout).not.toContain(`someone-${STAMP}@acme.example`);
  expect(stdout).not.toContain('token=secret');
  expect(stdout).not.toContain(rawKey);

  const dir = await mkdtemp(path.join(tmpdir(), 'review-'));
  const out = path.join(dir, 'shot.png');
  const notShared = await cli(baseURL, ['screenshot', ids.shot, out]);
  expect(notShared.stdout).toContain('no shared screenshot');
  await prisma.supportReport.update({ where: { id: ids.shot }, data: { screenshotSharedAt: new Date() } });
  await cli(baseURL, ['screenshot', ids.shot, out]);
  expect(Buffer.compare(await readFile(out), PNG)).toBe(0);

  const issue = 'https://github.com/21072026/Internship/issues/3939';
  const triaged = await cli(baseURL, ['triage', ids.shot, '--status', 'TRIAGED', '--issue', issue]);
  expect(JSON.parse(triaged.stdout)).toEqual({ id: ids.shot, status: 'TRIAGED', reviewIssueUrl: issue, prs: [], reporterNote: null });
  // The PR opened for it, with the reporter's note (#3972): the note's text never reaches stdout.
  const pull = 'https://github.com/21072026/Internship/pull/3972';
  const working = await cli(baseURL, ['triage', ids.shot, '--status', 'IN_PROGRESS', '--pr', pull, '--note', 'A fix is on its way.']);
  expect(JSON.parse(working.stdout)).toEqual({ id: ids.shot, status: 'IN_PROGRESS', reviewIssueUrl: issue, prs: [3972], reporterNote: 'set' });
  expect(working.stdout).not.toContain('on its way');
  expect((await prisma.supportReport.findUniqueOrThrow({ where: { id: ids.shot } })).reporterNote).toBe('A fix is on its way.');
  // A refused write says why and changes nothing.
  const refused = await cli(baseURL, ['triage', ids.plain, '--status', 'RESOLVED']).catch((e) => e);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain('422');
  expect((await prisma.supportReport.findUniqueOrThrow({ where: { id: ids.plain } })).status).toBe('NEW');
  // Only the untriaged one is still NEW.
  const left = JSON.parse((await cli(baseURL, ['list'])).stdout) as { id: string }[];
  expect(left.map((r) => r.id)).toEqual([ids.plain]);
});
