// Tests for the marketing-host content probe (#2579).
//
// The acceptance criterion is behavioural — "a host returning the wrong title
// turns the probe red; green is silent" — so the last block runs the real CLI
// against a local HTTP server that imitates each kind of host, and asserts on
// its exit code and stdout, which is exactly what uptime.yml reads.
//
// USAGE
//   node --test scripts/test/marketing-content-probe.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  extractTitle,
  titleProblem,
  probeTarget,
  parseTargets,
  run,
} from '../marketing-content-probe.mjs';

const SCRIPT = fileURLToPath(new URL('../marketing-content-probe.mjs', import.meta.url));

// The two titles the app really renders (src/app/layout.tsx generateMetadata).
const MARKETING_TITLE = 'SaleVali — Marketing CRM';
const INTERNSHIP_TITLE = 'Internship CRM - Mentor-Mentee Management';

const page = (title) =>
  `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${title}</title></head><body>x</body></html>`;

test('extractTitle reads the document title', () => {
  assert.equal(extractTitle(page(MARKETING_TITLE)), MARKETING_TITLE);
  assert.equal(extractTitle('<html><head></head><body></body></html>'), null);
  assert.equal(extractTitle(undefined), null);
});

test('extractTitle decodes entities and collapses whitespace', () => {
  assert.equal(extractTitle('<title>\n  SaleVali &amp; Co &#8212; x\n</title>'), 'SaleVali & Co — x');
  assert.equal(extractTitle('<title data-x="1">SaleVali&#x2014;y</title>'), 'SaleVali—y');
});

test('an inline SVG title is not the document title', () => {
  const html = `<html><body><svg><title>Internship CRM logo</title></svg><title>${MARKETING_TITLE}</title></body></html>`;
  assert.equal(extractTitle(html), MARKETING_TITLE);
});

test('titleProblem: SaleVali passes, the internship title and third things fail', () => {
  assert.equal(titleProblem(MARKETING_TITLE), null);
  assert.equal(titleProblem('Impressum | SaleVali'), null);
  assert.match(titleProblem(INTERNSHIP_TITLE), /internship product/);
  // Both names at once is still the wrong product showing through.
  assert.match(titleProblem('SaleVali · Internship CRM'), /internship product/);
  assert.match(titleProblem('502 Bad Gateway'), /does not name SaleVali/);
  assert.match(titleProblem(null), /no <title>/);
});

test('probeTarget turns HTTP and network failures into findings, never throws', async () => {
  const fake = (status, body) => async () => ({ status, text: async () => body });
  assert.deepEqual(await probeTarget('u', fake(200, page(MARKETING_TITLE))), { url: 'u', problem: null });
  assert.equal((await probeTarget('u', fake(503, ''))).problem, 'HTTP 503');
  const boom = async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  };
  assert.equal((await probeTarget('u', boom)).problem, 'fetch failed (ENOTFOUND)');
});

test('parseTargets prefers argv and falls back to CONTENT_TARGETS', () => {
  assert.deepEqual(parseTargets(['a', 'b'], { CONTENT_TARGETS: 'c' }), ['a', 'b']);
  assert.deepEqual(parseTargets([], { CONTENT_TARGETS: '  c\n d ' }), ['c', 'd']);
  assert.deepEqual(parseTargets([], {}), []);
});

test('run reports only the failing targets, one line each', async () => {
  const byUrl = { good: page(MARKETING_TITLE), bad: page(INTERNSHIP_TITLE) };
  const f = async (u) => ({ status: 200, text: async () => byUrl[u] });
  assert.deepEqual(await run(['good'], f), []);
  const lines = await run(['good', 'bad'], f);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^bad -> title "Internship CRM/);
});

// ── the acceptance criterion, end to end through the CLI ───────────────────
function serve() {
  const server = createServer((req, res) => {
    const routes = {
      '/right': [200, page(MARKETING_TITLE)],
      '/imprint': [200, page(MARKETING_TITLE)],
      '/wrong': [200, page(INTERNSHIP_TITLE)],
      '/down': [502, page('502 Bad Gateway')],
    };
    const [status, body] = routes[req.url] ?? [404, ''];
    res.writeHead(status, { 'content-type': 'text/html' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function cli(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH } });
    let stdout = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.on('close', (code) => resolve({ code, stdout }));
  });
}

test('CLI: green is silent, a wrong title turns it red', async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const green = await cli([`${base}/right`, `${base}/imprint`]);
    assert.equal(green.code, 0);
    assert.equal(green.stdout, '');

    const red = await cli([`${base}/right`, `${base}/wrong`, `${base}/down`]);
    assert.equal(red.code, 1);
    const lines = red.stdout.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /\/wrong -> title "Internship CRM/);
    assert.match(lines[1], /\/down -> HTTP 502/);
  } finally {
    server.close();
  }
});

test('CLI: no targets is a usage error, not a green run', async () => {
  const r = await cli([]);
  assert.equal(r.code, 2);
});
