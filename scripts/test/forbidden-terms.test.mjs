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
  COMMIT_FORMAT,
  prMetadata,
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

test('redact hides every path segment that holds a match, in every case, and nothing else', () => {
  assert.equal(redact('src/AcmeCorp/acme_corp.ts', patterns), 'src/***/***');
  assert.equal(redact('docs/plain.md', patterns), 'docs/plain.md');
  assert.equal(redact('docs/plain.md/x-WidgetWorks-y/z.ts', patterns), 'docs/plain.md/***/z.ts');
  assert.ok(!LEAK.test(redact('ACME.CORP widgetworks Widget Works', patterns)));
});

test('redact leaves no tail of a longer term: overlapping patterns, alternation, a term across "/"', () => {
  // Two patterns, the shorter applied first: replacing match ranges gave "***bar.md".
  const two = parseTerms('foo\nfoobar').patterns;
  assert.equal(redact('docs/foobar.md', two), 'docs/***');
  // One alternation whose first branch is a prefix of the second: "***cdef.md" before.
  const alt = parseTerms('ab|abcdef').patterns;
  assert.equal(redact('x/abcdef.md', alt), 'x/***');
  assert.ok(!/cdef|bar/.test(redact('x/abcdef.md', alt) + redact('docs/foobar.md', two)));
  // A term that only matches across a separator hides the whole path.
  const across = parseTerms('one/two').patterns;
  assert.equal(redact('a/one/two/b.md', across), '***');
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

test('parseCommits splits git log -z output: sha, author, committer, message', () => {
  assert.equal(COMMIT_FORMAT, '%H%n%an%n%ae%n%cn%n%ce%n%B');
  const z =
    'aaaaaaa1111\nAnn\nann@example.com\nGitHub\nnoreply@github.com\nfix: one\n\nbody line\n\0' +
    'bbbbbbb2222\nBob\nbob@example.com\nBob\nbob@example.com\nfeat: two\n\0';
  assert.deepEqual(parseCommits(z), [
    {
      sha: 'aaaaaaa1111',
      author: 'Ann <ann@example.com>',
      committer: 'GitHub <noreply@github.com>',
      message: 'fix: one\n\nbody line\n',
    },
    { sha: 'bbbbbbb2222', author: 'Bob <bob@example.com>', committer: 'Bob <bob@example.com>', message: 'feat: two\n' },
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
      { sha: '0123456789abcdef', message: 'fix: clean', author: 'A <a@example.com>', committer: 'A <a@example.com>' },
      { sha: 'fedcba9876543210', message: 'feat: support acme.corp', author: 'A <a@example.com>', committer: 'A <a@example.com>' },
      { sha: 'abcdef0123456789', message: 'fix: clean', author: 'Dev <dev@acmecorp.test>', committer: 'WidgetWorks <ci@example.com>' },
    ],
    branch: 'feat/12-acmecorp',
    title: 'Add widgetworks',
    body: 'Line one\nmentions AcmeCorp\n',
  };
  const lines = prFindings(pr, patterns).map((f) => format(f, patterns));
  assert.deepEqual(lines, [
    'src/ok.ts:2',
    'src/***:9',
    'src/*** (file name)',
    'commit fedcba9 message',
    'commit abcdef0 author',
    'commit abcdef0 committer',
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
    ['img/*** (file name)'],
  );
  assert.deepEqual(fileFindings('missing.txt', null, patterns), []);
});

test('prMetadata: env wins when set; otherwise the pull_request event payload', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'forbidden-terms-event-'));
  try {
    const eventPath = path.join(dir, 'event.json');
    writeFileSync(eventPath, JSON.stringify({ pull_request: { title: 'T', body: null, head: { ref: 'fix/1-x' } } }));
    assert.deepEqual(prMetadata({ GITHUB_EVENT_PATH: eventPath }), { branch: 'fix/1-x', title: 'T', body: '' });
    assert.deepEqual(prMetadata({ GITHUB_EVENT_PATH: eventPath, HEAD_REF: 'b', PR_TITLE: 't', PR_BODY: 'x' }), {
      branch: 'b',
      title: 't',
      body: 'x',
    });
    assert.deepEqual(prMetadata({}), { branch: '', title: '', body: '' });
    writeFileSync(eventPath, '{not json');
    assert.throws(() => prMetadata({ GITHUB_EVENT_PATH: eventPath }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  return { dir, base, head, git, write, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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

test('CLI: REQUIRE_TERMS=1 turns a missing list into a failure (a run that has the secrets)', () => {
  const repo = makeRepo();
  try {
    const r = cli(['--pr'], {
      cwd: repo.dir,
      env: { GITHUB_ACTIONS: 'true', REQUIRE_TERMS: '1', BASE_SHA: repo.base, HEAD_SHA: repo.head },
    });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /^::error title=Forbidden-terms guard not configured::/m);
    const blank = cli(['--push'], { cwd: repo.dir, env: { REQUIRE_TERMS: '1', FORBIDDEN_TERMS: '# none\n' } });
    assert.equal(blank.code, 2, blank.out);
    // Anything but "1" keeps the fork/Dependabot behaviour: a notice and a pass.
    assert.equal(cli(['--tree'], { cwd: repo.dir, env: { REQUIRE_TERMS: '' } }).code, 0);
  } finally {
    repo.cleanup();
  }
});

test('CLI --pr: commit author and committer are checked, and never printed', () => {
  const repo = makeRepo();
  try {
    repo.write('src/clean.ts', 'export const ok = true;\n');
    repo.git('add', '-A');
    repo.git('commit', '-q', '--author', 'Dev <dev@acme-corp.test>', '-m', 'chore: clean');
    const head = repo.git('rev-parse', 'HEAD');
    const r = cli(['--pr'], {
      cwd: repo.dir,
      env: { FORBIDDEN_TERMS: TERMS, BASE_SHA: repo.head, HEAD_SHA: head, HEAD_REF: 'chore/1-clean', PR_TITLE: 'clean', PR_BODY: '' },
    });
    assert.equal(r.code, 1, r.out);
    assert.ok(r.out.includes(`commit ${head.slice(0, 7)} author`), r.out);
    assert.ok(!r.out.includes(`commit ${head.slice(0, 7)} message`), r.out);
    assert.ok(!r.out.includes(`commit ${head.slice(0, 7)} committer`), r.out);
    assert.ok(!LEAK.test(r.out), `the output leaks:\n${r.out}`);
  } finally {
    repo.cleanup();
  }
});

test('CLI --pr in Actions: branch, title and body come from the event payload, not env', () => {
  const repo = makeRepo();
  const eventPath = path.join(repo.dir, '..', `event-${path.basename(repo.dir)}.json`);
  try {
    writeFileSync(
      eventPath,
      JSON.stringify({ pull_request: { title: 'Add WidgetWorks', body: 'clean', head: { ref: 'fix/2-acmecorp' } } }),
    );
    const r = cli(['--pr', '--base', repo.base, '--head', repo.base], {
      cwd: repo.dir,
      env: { GITHUB_ACTIONS: 'true', FORBIDDEN_TERMS: TERMS, GITHUB_EVENT_PATH: eventPath },
    });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /^PR title$/m);
    assert.match(r.out, /^branch name$/m);
    assert.ok(!/^PR body$/m.test(r.out), r.out);
    assert.ok(!LEAK.test(r.out), r.out);
    writeFileSync(eventPath, '{broken');
    const broken = cli(['--pr', '--base', repo.base, '--head', repo.base], {
      cwd: repo.dir,
      env: { FORBIDDEN_TERMS: TERMS, GITHUB_EVENT_PATH: eventPath },
    });
    assert.equal(broken.code, 2, broken.out);
  } finally {
    rmSync(eventPath, { force: true });
    repo.cleanup();
  }
});

test('CLI --push: what landed (lines, names, commits), without PR metadata', () => {
  const repo = makeRepo();
  try {
    const r = cli(['--push'], {
      cwd: repo.dir,
      env: { GITHUB_ACTIONS: 'true', FORBIDDEN_TERMS: TERMS, BASE_SHA: repo.base, HEAD_SHA: repo.head },
    });
    assert.equal(r.code, 1, r.out);
    assert.ok(r.out.includes('src/app.ts:2'), r.out);
    assert.ok(r.out.includes('src/***/index.ts (file name)'), r.out);
    assert.match(r.out, /commit [0-9a-f]{7} message/);
    assert.match(r.out, /^::error file=src\/app\.ts,line=2::/m);
    for (const absent of ['branch name', 'PR title', 'PR body', 'docs/old.md']) assert.ok(!r.out.includes(absent), r.out);
    assert.ok(!LEAK.test(r.out), `the output leaks:\n${r.out}`);
    const clean = cli(['--push', '--base', repo.base, '--head', repo.base], { cwd: repo.dir, env: { FORBIDDEN_TERMS: TERMS } });
    assert.equal(clean.code, 0, clean.out);
  } finally {
    repo.cleanup();
  }
});

test('CLI --push: a base that is gone (force-push) or all zeros checks the head commit alone', () => {
  const repo = makeRepo();
  try {
    for (const base of ['0'.repeat(40), 'e'.repeat(40)]) {
      const r = cli(['--push'], { cwd: repo.dir, env: { FORBIDDEN_TERMS: TERMS, BASE_SHA: base, HEAD_SHA: repo.head } });
      // The head commit only removes a line ("docs: clean up"): clean on its own.
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /only the head commit is checked/);
      assert.match(r.out, / 1 commit\(s\)/);
    }
    // --pr never falls back: a missing PR base is a broken checkout.
    const pr = cli(['--pr'], { cwd: repo.dir, env: { FORBIDDEN_TERMS: TERMS, BASE_SHA: 'e'.repeat(40), HEAD_SHA: repo.head } });
    assert.equal(pr.code, 2, pr.out);
  } finally {
    repo.cleanup();
  }
});
