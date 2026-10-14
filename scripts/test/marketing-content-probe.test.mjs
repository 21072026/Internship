// Tests for the marketing-host content probe (#2579, brand-free since #2919).
//
// The acceptance criterion is behavioural — "a host returning the wrong
// product turns the probe red; green is silent; nothing it prints names a host,
// a title or a brand" — so the last block runs the real CLI against a local
// HTTP server that imitates each kind of host, and asserts on its exit code,
// stdout and stderr, which is exactly what uptime.yml reads.
//
// The brand names below are made up. A real one does not belong in this
// repository: the probe reads it from the host it is probing.
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
  manifestName,
  judge,
  originKey,
  hostNumbers,
  targetLabel,
  probeTarget,
  parseTargets,
  run,
} from '../marketing-content-probe.mjs';

const SCRIPT = fileURLToPath(new URL('../marketing-content-probe.mjs', import.meta.url));

// The two shapes the app renders (src/app/layout.tsx generateMetadata and
// src/app/manifest.ts), with a stand-in brand.
const BRAND = 'Acme Sales';
const MARKETING_TITLE = `${BRAND} — Marketing CRM`;
const INTERNSHIP_TITLE = 'Internship CRM - Mentor-Mentee Management';

const page = (title) =>
  `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${title}</title></head><body>x</body></html>`;
const manifest = (name) => JSON.stringify({ id: '/', name, short_name: name, shortcuts: [{ name: 'Messages' }] });

test('extractTitle reads the document title', () => {
  assert.equal(extractTitle(page(MARKETING_TITLE)), MARKETING_TITLE);
  assert.equal(extractTitle('<html><head></head><body></body></html>'), null);
  assert.equal(extractTitle('<title>   </title>'), null);
  assert.equal(extractTitle(undefined), null);
});

test('extractTitle decodes entities and collapses whitespace', () => {
  assert.equal(extractTitle('<title>\n  Acme &amp; Co &#8212; x\n</title>'), 'Acme & Co — x');
  assert.equal(extractTitle('<title data-x="1">Acme&#x2014;y</title>'), 'Acme—y');
});

test('an inline SVG title is not the document title', () => {
  const html = `<html><body><svg><title>Internship CRM logo</title></svg><title>${MARKETING_TITLE}</title></body></html>`;
  assert.equal(extractTitle(html), MARKETING_TITLE);
});

test('manifestName reads the top-level name and nothing else', () => {
  assert.equal(manifestName(manifest(BRAND)), BRAND);
  assert.equal(manifestName(JSON.stringify({ name: `  ${BRAND}\n` })), BRAND);
  assert.equal(manifestName(JSON.stringify({ short_name: BRAND })), null);
  assert.equal(manifestName(JSON.stringify({ name: '   ' })), null);
  assert.equal(manifestName(JSON.stringify({ name: 7 })), null);
  assert.equal(manifestName('null'), null);
  assert.equal(manifestName('<html>502 Bad Gateway</html>'), null);
});

test('judge: a title carrying its own manifest name passes', () => {
  assert.equal(judge(MARKETING_TITLE, BRAND), null);
  assert.equal(judge(`Impressum · ${BRAND}`, BRAND), null);
  // Case and spacing are not a different product.
  assert.equal(judge('ACME  SALES — Marketing CRM', 'acme sales'), null);
});

test('judge: the internship product, the fallback and third things fail', () => {
  assert.match(judge(INTERNSHIP_TITLE, 'Internship CRM'), /internship product/);
  // Both names at once is still the wrong product showing through.
  assert.match(judge(`${BRAND} · Internship CRM`, BRAND), /internship product/);
  assert.match(judge(MARKETING_TITLE, 'Internship CRM'), /manifest names the internship product/);
  assert.match(judge('coreCRM — Marketing CRM', 'coreCRM'), /coreCRM fallback/);
  assert.match(judge('CORECRM — Marketing CRM', ' corecrm '), /coreCRM fallback/);
  assert.match(judge('502 Bad Gateway', BRAND), /does not contain the manifest name/);
  assert.match(judge(`Other Brand — Marketing CRM`, BRAND), /does not contain the manifest name/);
  assert.match(judge(MARKETING_TITLE, null), /manifest has no name/);
  assert.match(judge(null, BRAND), /no <title>/);
  assert.match(judge('  ', BRAND), /no <title>/);
});

test('judge never repeats the title or the name it was given', () => {
  const cases = [
    ['Other Brand — Marketing CRM', BRAND],
    ['Secret Title', 'Hidden Name'],
    [`${BRAND} · Internship CRM`, BRAND],
  ];
  for (const [title, name] of cases) {
    const reason = judge(title, name);
    assert.ok(reason);
    assert.ok(!reason.includes(name), `"${reason}" repeats the name`);
    assert.ok(!reason.includes(title), `"${reason}" repeats the title`);
  }
});

test('hosts are numbered by their origin, in order of first appearance', () => {
  assert.equal(originKey('https://A.example/imprint?x=1'), 'https://a.example');
  assert.equal(originKey('http://a.example:8080/'), 'http://a.example:8080');
  assert.equal(originKey('not a url'), 'not a url');
  assert.deepEqual(
    hostNumbers(['https://a.example/', 'https://b.example/', 'https://a.example/imprint', 'https://C.example', 'https://b.example/x']),
    [1, 2, 1, 3, 2],
  );
  assert.equal(targetLabel(2, 5), 'marketing host #2, page #5');
});

const fakeFetch = (routes) => async (url) => {
  const hit = routes[url];
  if (hit instanceof Error) throw hit;
  const [status, body] = hit ?? [404, ''];
  return { status, url, text: async () => body };
};

test('probeTarget judges the page against its own host manifest', async () => {
  const f = fakeFetch({
    'https://a.example/': [200, page(MARKETING_TITLE)],
    'https://a.example/manifest.webmanifest': [200, manifest(BRAND)],
  });
  assert.deepEqual(await probeTarget('https://a.example/', f), { url: 'https://a.example/', problem: null });
});

test('probeTarget turns HTTP and network failures into findings, never throws', async () => {
  const boom = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  const f = fakeFetch({
    'https://down.example/': [503, ''],
    'https://gone.example/': boom,
    'https://nomani.example/': [200, page(MARKETING_TITLE)],
    'https://nomani.example/manifest.webmanifest': [404, ''],
    'https://badmani.example/': [200, page(MARKETING_TITLE)],
    'https://badmani.example/manifest.webmanifest': boom,
  });
  assert.equal((await probeTarget('https://down.example/', f)).problem, 'HTTP 503');
  assert.equal((await probeTarget('https://gone.example/', f)).problem, 'fetch failed (ENOTFOUND)');
  assert.equal((await probeTarget('https://nomani.example/', f)).problem, 'manifest HTTP 404');
  assert.equal((await probeTarget('https://badmani.example/', f)).problem, 'manifest fetch failed (ENOTFOUND)');
});

test('the manifest is read from the host that answered, once per run', async () => {
  const asked = [];
  const f = async (url) => {
    asked.push(url);
    if (url === 'https://old.example/') return { status: 200, url: 'https://new.example/', text: async () => page(MARKETING_TITLE) };
    if (url === 'https://new.example/imprint') return { status: 200, url, text: async () => page(`Impressum · ${BRAND}`) };
    if (url === 'https://new.example/manifest.webmanifest') return { status: 200, url, text: async () => manifest(BRAND) };
    return { status: 404, url, text: async () => '' };
  };
  assert.deepEqual(await run(['https://old.example/', 'https://new.example/imprint'], f), []);
  assert.equal(asked.filter((u) => u.endsWith('/manifest.webmanifest')).length, 1);
});

test('parseTargets prefers argv and falls back to MARKETING_PROBE_URLS', () => {
  assert.deepEqual(parseTargets(['a', 'b'], { MARKETING_PROBE_URLS: 'c' }), ['a', 'b']);
  assert.deepEqual(parseTargets([], { MARKETING_PROBE_URLS: '  c\n d ' }), ['c', 'd']);
  assert.deepEqual(parseTargets([], {}), []);
});

test('run reports only the failing targets, by position, one line each', async () => {
  const f = fakeFetch({
    'https://good.example/': [200, page(MARKETING_TITLE)],
    'https://good.example/manifest.webmanifest': [200, manifest(BRAND)],
    'https://bad.example/': [200, page(INTERNSHIP_TITLE)],
    'https://bad.example/manifest.webmanifest': [200, manifest('Internship CRM')],
  });
  const log = [];
  assert.deepEqual(await run(['https://good.example/'], f), []);
  const lines = await run(['https://good.example/', 'https://bad.example/'], f, (l) => log.push(l));
  assert.deepEqual(lines, ['marketing host #2, page #2 -> the title is the internship product']);
  assert.deepEqual(log, ['marketing host #1, page #1: OK', 'marketing host #2, page #2: FAIL']);
});

// ── the acceptance criterion, end to end through the CLI ───────────────────
// One local server per imitated host: real hosts differ by origin, and the
// probe reads each page's manifest from that page's own origin.
function serveHost(title, name, status = 200) {
  const server = createServer((req, res) => {
    if (req.url === '/manifest.webmanifest') {
      res.writeHead(200, { 'content-type': 'application/manifest+json' });
      return res.end(manifest(name));
    }
    if (req.url === '/' || req.url === '/imprint') {
      res.writeHead(status, { 'content-type': 'text/html' });
      return res.end(page(title));
    }
    res.writeHead(404);
    res.end('');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function cli(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, ...env } });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('CLI: green is silent, the wrong product turns it red, nothing names a host', async () => {
  const right = await serveHost(MARKETING_TITLE, BRAND);
  const wrong = await serveHost(INTERNSHIP_TITLE, 'Internship CRM');
  const unbranded = await serveHost('coreCRM — Marketing CRM', 'coreCRM');
  const down = await serveHost('502 Bad Gateway', BRAND, 502);
  const url = (s, path = '/') => `http://127.0.0.1:${s.address().port}${path}`;
  try {
    const green = await cli([], { MARKETING_PROBE_URLS: `${url(right)}\n${url(right, '/imprint')}` });
    assert.equal(green.code, 0);
    assert.equal(green.stdout, '');
    assert.match(green.stderr, /marketing host #1, page #1: OK/);
    assert.match(green.stderr, /marketing host #1, page #2: OK/);

    const red = await cli([url(right), url(wrong), url(unbranded), url(down)]);
    assert.equal(red.code, 1);
    assert.deepEqual(red.stdout.trim().split('\n'), [
      'marketing host #2, page #2 -> the title is the internship product',
      'marketing host #3, page #3 -> the manifest carries the coreCRM fallback name, so the brand is missing',
      'marketing host #4, page #4 -> HTTP 502',
    ]);
    for (const out of [red.stdout, red.stderr, green.stderr]) {
      assert.ok(!out.includes('127.0.0.1'), 'a target URL reached the output');
      assert.ok(!out.includes(BRAND), 'a brand reached the output');
      assert.ok(!out.includes('Mentor-Mentee'), 'a title reached the output');
    }
  } finally {
    for (const s of [right, wrong, unbranded, down]) s.close();
  }
});

test('CLI: no targets is a usage error, not a green run', async () => {
  const r = await cli([]);
  assert.equal(r.code, 2);
  const blank = await cli([], { MARKETING_PROBE_URLS: ' \n ' });
  assert.equal(blank.code, 2);
});
