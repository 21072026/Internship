#!/usr/bin/env node
// The feedback review's hands (#3939, .claude/skills/feedback-review/SKILL.md).
// Three calls of the public API, nothing else:
//
//   node scripts/feedback-review.mjs list [--status NEW] [--limit 50]
//       → the reports, masked (GET /api/v1/support/reports, support:read), as JSON
//   node scripts/feedback-review.mjs screenshot <reportId> <outFile>
//       → the screenshot, ONLY if an admin shared it (#3936,
//         support:read_shared_screenshots); otherwise says so and writes nothing
//   node scripts/feedback-review.mjs triage <reportId> [--status TRIAGED|IN_PROGRESS|WONT_FIX|NEW] [--issue <url>|--no-issue]
//                                        [--pr <pull url>] [--note "<answer for the reporter>"|--no-note]
//       → PATCH /api/v1/support/reports/{id} (support:triage, #3937; --pr and --note #3972)
//
// Environment (never on the command line, never printed):
//   SUPPORT_REVIEW_API_KEY   the review key: support:read, support:read_shared_screenshots, support:triage
//   SUPPORT_REVIEW_BASE_URL  the deployment it belongs to, e.g. https://<host>
// Without either it stops with exit code 2 and says what is missing.
import { writeFile } from 'node:fs/promises';

const KEY = process.env.SUPPORT_REVIEW_API_KEY ?? '';
const BASE = (process.env.SUPPORT_REVIEW_BASE_URL ?? '').replace(/\/+$/, '');

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const positional = [];
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--no-issue') flags.issue = null;
    else if (a === '--no-note') flags.note = null;
    else if (a.startsWith('--')) {
      flags[a.slice(2)] = rest[i + 1];
      i += 1;
    } else positional.push(a);
  }
  return { command, positional, flags };
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

async function call(path, init = {}) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    ...init,
    headers: { authorization: `Bearer ${KEY}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
  });
  return res;
}

async function problem(res) {
  const body = await res.json().catch(() => ({}));
  const detail = body.errors?.map((e) => `${e.path}: ${e.code}`).join(', ') || body.detail || body.title || '';
  return `${res.status} ${body.type ?? body.code ?? ''} ${detail}`.trim();
}

async function list(flags) {
  const status = flags.status ?? 'NEW';
  const limit = Math.min(Math.max(Number(flags.limit) || 50, 1), 50);
  const out = [];
  let cursor = null;
  do {
    const q = new URLSearchParams({ status, limit: String(limit), ...(cursor ? { cursor } : {}) });
    const res = await call(`/support/reports?${q}`);
    if (!res.ok) fail(`list failed: ${await problem(res)}`);
    const body = await res.json();
    out.push(...body.data);
    cursor = body.page?.hasMore ? body.page.nextCursor : null;
  } while (cursor && out.length < 500);
  console.log(JSON.stringify(out, null, 2));
}

async function screenshot([id, outFile]) {
  if (!id || !outFile) fail('usage: screenshot <reportId> <outFile>');
  const res = await call(`/support/reports/${encodeURIComponent(id)}/screenshot`);
  if (res.status === 404) {
    console.log(`no shared screenshot for ${id}: ask an admin to tick "Share the screenshot with the feedback review" on the report page`);
    return;
  }
  if (!res.ok) fail(`screenshot failed: ${await problem(res)}`);
  await writeFile(outFile, Buffer.from(await res.arrayBuffer()));
  console.log(`saved ${outFile} (${res.headers.get('content-type')})`);
}

async function triage([id], flags) {
  if (!id) fail('usage: triage <reportId> [--status …] [--issue <url>|--no-issue] [--pr <url>] [--note <text>|--no-note]');
  const body = {};
  if (flags.status !== undefined) body.status = flags.status;
  if ('issue' in flags) body.issueUrl = flags.issue;
  if (flags.pr !== undefined) body.prUrl = flags.pr;
  if ('note' in flags) body.reporterNote = flags.note;
  if (Object.keys(body).length === 0) fail('triage needs --status, --issue, --no-issue, --pr, --note or --no-note');
  const res = await call(`/support/reports/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) });
  if (!res.ok) fail(`triage failed: ${await problem(res)}`);
  const { data } = await res.json();
  console.log(
    JSON.stringify({
      id: data.id,
      status: data.status,
      reviewIssueUrl: data.reviewIssueUrl,
      prs: (data.prLinks ?? []).map((l) => l.number),
      reporterNote: data.reporterNote ? 'set' : null,
    }),
  );
}

async function main() {
  if (!KEY || !BASE) {
    fail(
      'feedback review is not set up: set SUPPORT_REVIEW_API_KEY (a key holding support:read, ' +
        'support:read_shared_screenshots and support:triage, minted by an admin under Integrations → API keys) ' +
        'and SUPPORT_REVIEW_BASE_URL (the deployment it belongs to) in your local environment. Nothing was read.',
      2,
    );
  }
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  if (command === 'list') return list(flags);
  if (command === 'screenshot') return screenshot(positional);
  if (command === 'triage') return triage(positional, flags);
  fail('usage: list | screenshot <id> <out> | triage <id> [--status S] [--issue URL|--no-issue] [--pr URL] [--note TEXT|--no-note]');
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
