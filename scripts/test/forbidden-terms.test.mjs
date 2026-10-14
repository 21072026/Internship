// Tests for the forbidden-terms guard (#2919).
//
// Every term here is SYNTHETIC ("acmecorp" and friends). The real list lives
// only in the FORBIDDEN_TERMS secret and must never be written into this
// repository, a test included.
//
// The property that matters most is negative: the guard must never print what
// it matched, in any case or spelling, nor a pattern. Several tests below
// assert exactly that on the real CLI output, against a throwaway git
// repository built for the purpose.
//
// USAGE
//   node --test scripts/test/forbidden-terms.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseTerms,
  hitLines,
  redact,
  isBinary,
  unquotePath,
  parseAddedLines,
  parseNewPaths,
  parseBinaryPaths,
  parseCommits,
  prFindings,
  fileFindings,
  format,
} from '../check-forbidden-terms.mjs';

const SCRIPT = fileURLToPath(new URL('../check-forbidden-terms.mjs', import.meta.url));
const TERMS = 'acme[ _.-]?corp\n\n# a comment line is not a term\nwidget ?works';
const { patterns } = parseTerms(TERMS);
// Anything that could betray a match, in any case. A sha never contains these
// letters ("m", "r", "o", "p", "w", "k" are not hex), so the check is exact.
const LEAK = /acme|corp|widget|works/i;

test('parseTerms: one case-insensitive pattern per line, comments and blanks skipped', () => {
  const parsed = parseTerms(TERMS);
  assert.equal(parsed.patterns.length, 2);
  assert.deepEqual(parsed.invalidLines, []);
  assert.ok(parsed.patterns[0].test('ACME-Corp'));
  assert.ok(parsed.patterns[1].test('WidgetWorks'));
  assert.deepEqual(parseTerms('').patterns, []);
  assert.deepEqual(parseTerms(undefined).patterns, []);
  assert.deepEqual(parseTerms('  \r\n# only a comment\r\n').patterns, []);
});

test('parseTerms: an invalid line is reported by number and never compiled', () => {
  const parsed = parseTerms('acmecorp\n(unclosed\nwidget');
  assert.deepEqual(parsed.invalidLines, [2]);
  assert.equal(parsed.patterns.length, 2);
});

test('hitLines finds every matching line, CRLF or not', () => {
  assert.deepEqual(hitLines('one\nAcmeCorp two\nthree\r\nwidget works\r\n', patterns), [2, 4]);
  assert.deepEqual(hitLines('nothing here', patterns), []);
});

test('redact hides every match, in every case, and nothing else', () => {
  assert.equal(redact('src/AcmeCorp/acme_corp.ts', patterns), 'src/***/***.ts');
  assert.equal(redact('docs/plain.md', patterns), 'docs/plain.md');
  assert.ok(!LEAK.test(redact('ACME.CORP widgetworks Widget Works', patterns)));
});

test('isBinary uses the NUL-byte heuristic', () => {
  assert.equal(isBinary(Buffer.from('plain text\n')), false);
  assert.equal(isBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])), true);
});

test('unquotePath reads the paths git C-quotes', () => {
  assert.equal(unquotePath('b/plain.txt'), 'b/plain.txt');
  assert.equal(unquotePath('"b/a\\"b.txt"'), 'b/a"b.txt');
  assert.equal(unquotePath('"b/caf\\303\\251\\ttab.txt"'), 'b/café\ttab.txt');
  assert.equal(unquotePath('"b/emoji-😀\\\\x"'), 'b/emoji-😀\\x');
});

test('parseAddedLines: added lines with their new line numbers, per file', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 111..222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -3 +3,2 @@ context',
    '-old line',
    '+new line',
    '++++ looks like a header but is content',
    '@@ -10,0 +12 @@',
    '+twelve',
    '\\ No newline at end of file',
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
    'diff --git a/with space.txt b/with space.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/with space.txt\t',
    '@@ -0,0 +1 @@',
    '+first',
    'diff --git a/img.png b/img.png',
    'Binary files a/img.png and b/img.png differ',
  ].join('\n');
  assert.deepEqual(parseAddedLines(diff), [
    { path: 'src/a.ts', line: 3, text: 'new line' },
    { path: 'src/a.ts', line: 4, text: '+++ looks like a header but is content' },
    { path: 'src/a.ts', line: 12, text: 'twelve' },
    { path: 'with space.txt', line: 1, text: 'first' },
  ]);
});

test('parseNewPaths: added, renamed and copied files bring a new name; modified and deleted do not', () => {
  const z = ['M', 'kept.ts', 'A', 'new.ts', 'D', 'gone.ts', 'R087', 'old.ts', 'moved.ts', 'C100', 'src.ts', 'copy.ts', 'T', 'type.ts', ''].join('\0');
  assert.deepEqual(parseNewPaths(z), ['new.ts', 'moved.ts', 'copy.ts']);
  assert.deepEqual(parseNewPaths(''), []);
});

test('parseBinaryPaths: "-" counts mean binary, renames included', () => {
  const z = ['3\t1\ttext.ts', '-\t-\tlogo.png', '-\t-\t', 'old.pdf', 'new.pdf', '1\t0\t', 'a.md', 'b.md', ''].join('\0');
  assert.deepEqual(parseBinaryPaths(z), ['logo.png', 'new.pdf']);
});

test('parseCommits splits git log -z output', () => {
  const z = 'aaaaaaa1111\nfix: one\n\nbody line\n\0bbbbbbb2222\nfeat: two\n\0';
  assert.deepEqual(parseCommits(z), [
    { sha: 'aaaaaaa1111', message: 'fix: one\n\nbody line\n' },
    { sha: 'bbbbbbb2222', message: 'feat: two\n' },
  ]);
});

test('prFindings + format: every channel, located, never quoted', () => {
  const pr = {
    added: [
      { path: 'src/ok.ts', line: 1, text: 'fine' },
      { path: 'src/ok.ts', line: 2, text: 'const x = "ACME CORP";' },
      { path: 'src/acme-corp.ts', line: 9, text: 'Widget Works' },
    ],
    newPaths: ['src/acme-corp.ts', 'src/clean.ts'],
    commits: [
      { sha: '0123456789abcdef', message: 'fix: clean' },
      { sha: 'fedcba9876543210', message: 'feat: support acme.corp' },
    ],
    branch: 'feat/12-acmecorp',
    title: 'Add widgetworks',
    body: 'Line one\nmentions AcmeCorp\n',
  };
  const lines = prFindings(pr, patterns).map((f) => format(f, patterns));
  assert.deepEqual(lines, [
    'src/ok.ts:2',
    'src/***.ts:9',
    'src/***.ts (file name)',
    'commit fedcba9 message',
    'branch name',
    'PR title',
    'PR body',
  ]);
  for (const line of lines) assert.ok(!LEAK.test(line), `leaks: ${line}`);
  assert.deepEqual(prFindings({ added: [], newPaths: [], commits: [], branch: 'fix/1-x', title: 't', body: '' }, patterns), []);
});

test('fileFindings: path and text lines; a binary file is judged by its path only', () => {
  assert.deepEqual(
    fileFindings('docs/x.md', { text: 'a\nacmecorp\n' }, patterns).map((f) => format(f, patterns)),
    ['docs/x.md:2'],
  );
  assert.deepEqual(
    fileFindings('img/AcmeCorp.png', { binary: true }, patterns).map((f) => format(f, patterns)),
    ['img/***.png (file name)'],
  );
  assert.deepEqual(fileFindings('missing.txt', null, patterns), []);
});

// ── The real CLI against a throwaway repository ──────────────────────────────

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'forbidden-terms-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: dir, env, encoding: 'utf8' }).trim();
  const write = (rel, content) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  };
  git('init', '-q', '-b', 'main');
  write('README.md', 'A clean project.\n');
  write('docs/old.md', 'Legacy note about AcmeCorp.\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'topic');
  write('src/app.ts', 'export const a = 1;\nexport const name = "Acme_Corp";\n');
  write('src/acme-corp/index.ts', 'export {};\n');
  write('assets/logo.bin', Buffer.from([0x00, 0x01, 0x02, 0x41]));
  git('add', '-A');
  git('commit', '-q', '-m', 'feat: wire up the WIDGET WORKS adapter');
  // The legacy line is REMOVED in the PR: deleting a name is never a finding.
  write('docs/old.md', 'Legacy note.\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'docs: clean up');
  const head = git('rev-parse', 'HEAD');
  return { dir, base, head, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function cli(args, { cwd, env = {} }) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME ?? '', GIT_CONFIG_NOSYSTEM: '1', ...env },
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('CLI --pr: blocks what a PR adds, and says where without saying what', () => {
  const repo = makeRepo();
  try {
    const r = cli(['--pr'], {
      cwd: repo.dir,
      env: {
        FORBIDDEN_TERMS: TERMS,
        BASE_SHA: repo.base,
        HEAD_SHA: repo.head,
        HEAD_REF: 'feat/7-acmecorp-adapter',
        PR_TITLE: 'Clean title',
        PR_BODY: 'Mentions Widget Works once.',
      },
    });
    assert.equal(r.code, 1, r.out);
    for (const expected of ['src/app.ts:2', 'src/***/index.ts (file name)', 'message', 'branch name', 'PR body']) {
      assert.ok(r.out.includes(expected), `missing "${expected}" in:\n${r.out}`);
    }
    assert.match(r.out, /commit [0-9a-f]{7} message/);
    assert.ok(!r.out.includes('PR title'), r.out);
    assert.ok(!r.out.includes('docs/old.md'), 'a deleted line was reported');
    assert.match(r.out, /1 unscannable binary file/);
    assert.ok(!LEAK.test(r.out), `the output leaks a match or a pattern:\n${r.out}`);
  } finally {
    repo.cleanup();
  }
});

test('CLI --pr: a clean PR passes', () => {
  const repo = makeRepo();
  try {
    const r = cli(['--pr', '--base', repo.base, '--head', repo.base], {
      cwd: repo.dir,
      env: { FORBIDDEN_TERMS: TERMS, HEAD_REF: 'fix/1-clean', PR_TITLE: 'ok', PR_BODY: '' },
    });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /no forbidden term found/);
  } finally {
    repo.cleanup();
  }
});

test('CLI --tree: every tracked path and text file, binaries counted', () => {
  const repo = makeRepo();
  try {
    const summaryFile = path.join(repo.dir, '..', `summary-${path.basename(repo.dir)}.md`);
    const r = cli(['--tree'], { cwd: repo.dir, env: { FORBIDDEN_TERMS: TERMS, GITHUB_STEP_SUMMARY: summaryFile } });
    assert.equal(r.code, 1, r.out);
    assert.ok(r.out.includes('src/app.ts:2'), r.out);
    assert.ok(r.out.includes('src/***/index.ts (file name)'), r.out);
    assert.match(r.out, /1 unscannable binary file/);
    assert.ok(!LEAK.test(r.out), `the output leaks a match or a pattern:\n${r.out}`);
    const summary = readFileSync(summaryFile, 'utf8');
    assert.match(summary, /finding/);
    assert.ok(!LEAK.test(summary), `the job summary leaks:\n${summary}`);
    rmSync(summaryFile, { force: true });
  } finally {
    repo.cleanup();
  }
});

test('CLI: no FORBIDDEN_TERMS is a notice and a pass, never a failure', () => {
  const repo = makeRepo();
  try {
    const plain = cli(['--tree'], { cwd: repo.dir });
    assert.equal(plain.code, 0, plain.out);
    assert.match(plain.out, /FORBIDDEN_TERMS is not set/);
    const actions = cli(['--pr'], { cwd: repo.dir, env: { GITHUB_ACTIONS: 'true', FORBIDDEN_TERMS: '\n# nothing\n' } });
    assert.equal(actions.code, 0, actions.out);
    assert.match(actions.out, /^::notice title=Forbidden-terms guard skipped::/m);
  } finally {
    repo.cleanup();
  }
});

test('CLI: an invalid term fails by line number, without printing it', () => {
  const repo = makeRepo();
  try {
    const r = cli(['--tree'], { cwd: repo.dir, env: { FORBIDDEN_TERMS: 'acmecorp\nwidget(works' } });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /line\(s\) 2 /);
    assert.ok(!LEAK.test(r.out), r.out);
  } finally {
    repo.cleanup();
  }
});

test('CLI: usage errors exit 2', () => {
  const repo = makeRepo();
  try {
    assert.equal(cli([], { cwd: repo.dir, env: { FORBIDDEN_TERMS: TERMS } }).code, 2);
    assert.equal(cli(['--bogus'], { cwd: repo.dir, env: { FORBIDDEN_TERMS: TERMS } }).code, 2);
    assert.equal(cli(['--pr'], { cwd: repo.dir, env: { FORBIDDEN_TERMS: TERMS } }).code, 2);
    const missing = cli(['--pr'], { cwd: repo.dir, env: { FORBIDDEN_TERMS: TERMS, BASE_SHA: 'f'.repeat(40), HEAD_SHA: repo.head } });
    assert.equal(missing.code, 2);
    assert.match(missing.out, /base commit is not in this clone/);
  } finally {
    repo.cleanup();
  }
});

test('CLI --pr in Actions: annotations name the file only when the path is clean', () => {
  const repo = makeRepo();
  try {
    const r = cli(['--pr'], {
      cwd: repo.dir,
      env: { GITHUB_ACTIONS: 'true', FORBIDDEN_TERMS: TERMS, BASE_SHA: repo.base, HEAD_SHA: repo.head },
    });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /^::error file=src\/app\.ts,line=2::/m);
    assert.match(r.out, /^::error::src\/\*\*\*\/index\.ts \(file name\): /m);
    assert.ok(!LEAK.test(r.out), r.out);
  } finally {
    repo.cleanup();
  }
});
