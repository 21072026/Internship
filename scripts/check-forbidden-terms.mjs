#!/usr/bin/env node
// Forbidden-terms guard (#2919).
//
// WHY THIS EXISTS
//   Some names must not appear on the visible surface of this repository: not
//   in a file, a file name, a commit message, a branch name or a PR title or
//   body. A cleanup removes them once; this check keeps a new change from
//   bringing one back. A review cannot do that reliably. A name slips into a
//   test fixture, a comment or a commit message as easily as into the code.
//
// WHERE THE TERMS COME FROM
//   ONLY from the FORBIDDEN_TERMS environment variable, which CI fills from the
//   secret of the same name: one case-insensitive JavaScript regular
//   expression per line, blank lines and lines starting with `#` ignored. The
//   list is never committed, because a committed list would publish the very
//   names it exists to keep out.
//
// WHAT IT PRINTS
//   Locations only, never what matched and never a pattern. GitHub masks the
//   secret's exact text in a log, but a match in another case or spelling is
//   not the secret's text and would be printed in the clear. So a finding is
//   `path:line`, `<path> (file name)`, `commit <sha7> message`, `PR title`,
//   `PR body` or `branch name`. A path that itself matches is printed with each
//   match replaced by `***`.
//
// MODES
//   --pr    What a pull request ADDS: the added lines of `git diff base...head`,
//           the paths of added, renamed and copied files, every commit message
//           in `base..head`, the head branch name and the PR title and body.
//           Inputs: BASE_SHA, HEAD_SHA (or --base/--head), and optionally
//           HEAD_REF, PR_TITLE, PR_BODY. Lines a PR deletes are fine: removing
//           a name is the point.
//   --tree  The whole tracked tree: every tracked path, and the content of
//           every tracked text file in the working tree. Binary files cannot be
//           scanned as text; they are counted as "unscannable binary".
//
// EXIT CODES
//   0  nothing found, or FORBIDDEN_TERMS is not set (a fork PR gets no
//      secrets; the --tree run after the merge covers it). A notice says so.
//   1  something was found.
//   2  usage or configuration error: an unknown mode, missing commits, or a
//      line of FORBIDDEN_TERMS that is not a valid regular expression (named by
//      its line number only).
//
// USAGE
//   FORBIDDEN_TERMS="$(cat terms.txt)" node scripts/check-forbidden-terms.mjs --tree
//   FORBIDDEN_TERMS="$(cat terms.txt)" node scripts/check-forbidden-terms.mjs --pr --base origin/main --head HEAD
//   Tests: node --test scripts/test/forbidden-terms.test.mjs
//
// Plain ESM with no dependency, like the other scripts CI runs before `npm ci`.

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// ── The term list ────────────────────────────────────────────────────────────

// One RegExp per usable line. An invalid line is reported by its line number
// and never compiled into the list, so one typo cannot silently disable the
// whole check (the caller exits 2 on any invalid line).
export function parseTerms(raw) {
  const patterns = [];
  const invalidLines = [];
  String(raw ?? '')
    .split(/\r?\n/)
    .forEach((line, i) => {
      const source = line.trim();
      if (!source || source.startsWith('#')) return;
      try {
        patterns.push(new RegExp(source, 'i'));
      } catch {
        invalidLines.push(i + 1);
      }
    });
  return { patterns, invalidLines };
}

export function matchesAny(text, patterns) {
  return patterns.some((p) => p.test(text));
}

// The 1-based numbers of the lines that match any pattern.
export function hitLines(text, patterns) {
  const hits = [];
  String(text)
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (matchesAny(line, patterns)) hits.push(i + 1);
    });
  return hits;
}

// The text with every match of every pattern replaced by `***`. Used on paths
// before they are printed; never needed for anything else, because nothing
// else that matched is ever printed.
export function redact(text, patterns) {
  return patterns.reduce(
    (out, p) => out.replace(new RegExp(p.source, 'gi'), (m) => (m ? '***' : m)),
    String(text),
  );
}

// Git's own heuristic: a NUL byte in the first 8000 bytes means binary.
export function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

// ── Parsing git's output ─────────────────────────────────────────────────────

// A path as `git diff` prints it on a `+++` line: either plain or C-quoted
// ("b/a\"b.txt") when it holds unusual characters. A path with a space gets a
// trailing TAB on that line (for GNU patch), which is not part of the name.
export function unquotePath(raw) {
  if (!raw.startsWith('"')) return raw;
  const body = raw.slice(1, raw.lastIndexOf('"'));
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      const cp = body.codePointAt(i);
      bytes.push(...Buffer.from(String.fromCodePoint(cp), 'utf8'));
      if (cp > 0xffff) i++; // the second half of a surrogate pair
      continue;
    }
    const next = body[++i];
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else {
      const simple = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '\\': 92, '"': 34 };
      bytes.push(simple[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// The added lines of `git diff --unified=0`, each with its path and its line
// number in the new file. Deletions and binary files produce none.
export function parseAddedLines(diff) {
  const added = [];
  let path = null;
  let inHunk = false;
  let line = 0;
  for (const raw of String(diff).split('\n')) {
    if (raw.startsWith('diff --git ')) {
      path = null;
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      if (raw.startsWith('+++ ')) {
        const target = raw.slice(4).replace(/\t$/, '');
        path = target === '/dev/null' ? null : unquotePath(target).replace(/^b\//, '');
      }
      if (!raw.startsWith('@@')) continue;
    }
    if (raw.startsWith('@@')) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      inHunk = Boolean(m);
      line = m ? Number(m[1]) : 0;
      continue;
    }
    if (raw.startsWith('+')) {
      if (path !== null) added.push({ path, line, text: raw.slice(1) });
      line++;
    } else if (raw.startsWith(' ')) {
      line++;
    }
    // '-' lines and "\ No newline at end of file" move nothing in the new file.
  }
  return added;
}

// `git diff --name-status -z`: the paths a change brings INTO the tree under a
// new name — added, renamed (the new name) and copied files. A modified file
// kept its old name, which the --tree scan covers.
export function parseNewPaths(nameStatusZ) {
  const fields = String(nameStatusZ).split('\0');
  const paths = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i];
    if (!status) {
      i++;
      continue;
    }
    if (status[0] === 'R' || status[0] === 'C') {
      paths.push(fields[i + 2]);
      i += 3;
    } else {
      if (status[0] === 'A') paths.push(fields[i + 1]);
      i += 2;
    }
  }
  return paths.filter(Boolean);
}

// `git diff --numstat -z`: the paths whose change is binary (`-` counts).
export function parseBinaryPaths(numstatZ) {
  const fields = String(numstatZ).split('\0');
  const binaries = [];
  for (let i = 0; i < fields.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(fields[i]);
    if (!m) continue;
    // A rename leaves the third column empty and puts old and new names in
    // the next two fields.
    let path = m[3];
    if (path === '') {
      path = fields[i + 2];
      i += 2;
    }
    if (m[1] === '-' && m[2] === '-') binaries.push(path);
  }
  return binaries.filter(Boolean);
}

// `git log -z --format=%H%n%B`: one { sha, message } per commit.
export function parseCommits(logZ) {
  return String(logZ)
    .split('\0')
    .filter((record) => record.trim())
    .map((record) => {
      const nl = record.indexOf('\n');
      return nl < 0
        ? { sha: record.trim(), message: '' }
        : { sha: record.slice(0, nl).trim(), message: record.slice(nl + 1) };
    });
}

// ── Findings ─────────────────────────────────────────────────────────────────

// Everything a PR adds, judged. `pr` is already parsed: { added, newPaths,
// commits, branch, title, body }. Returns finding objects; format() turns them
// into the only text that is ever printed.
export function prFindings(pr, patterns) {
  const findings = [];
  for (const { path, line, text } of pr.added ?? []) {
    if (matchesAny(text, patterns)) findings.push({ kind: 'line', path, line });
  }
  for (const path of pr.newPaths ?? []) {
    if (matchesAny(path, patterns)) findings.push({ kind: 'path', path });
  }
  for (const { sha, message } of pr.commits ?? []) {
    if (matchesAny(message, patterns)) findings.push({ kind: 'commit', sha });
  }
  if (pr.branch && matchesAny(pr.branch, patterns)) findings.push({ kind: 'branch' });
  if (pr.title && matchesAny(pr.title, patterns)) findings.push({ kind: 'title' });
  if (pr.body && matchesAny(pr.body, patterns)) findings.push({ kind: 'body' });
  return findings;
}

// One tracked file, judged: its path, and its text unless it is binary.
// `content` is { text }, { binary: true }, or null for a file that is not
// there to read.
export function fileFindings(path, content, patterns) {
  const findings = [];
  if (matchesAny(path, patterns)) findings.push({ kind: 'path', path });
  if (content && !content.binary) {
    for (const line of hitLines(content.text, patterns)) findings.push({ kind: 'line', path, line });
  }
  return findings;
}

export function format(finding, patterns) {
  const where = () => redact(finding.path, patterns);
  switch (finding.kind) {
    case 'line':
      return `${where()}:${finding.line}`;
    case 'path':
      return `${where()} (file name)`;
    case 'commit':
      return `commit ${finding.sha.slice(0, 7)} message`;
    case 'branch':
      return 'branch name';
    case 'title':
      return 'PR title';
    case 'body':
      return 'PR body';
    default:
      return 'unknown finding';
  }
}

// A GitHub annotation for a finding whose path is safe to name in full. Paths
// that themselves match get no annotation: an annotation's `file` has to be
// the real path.
function annotation(finding, patterns) {
  const prop = (v) =>
    String(v).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/:/g, '%3A').replace(/,/g, '%2C');
  const msg = 'This change adds a term from the FORBIDDEN_TERMS list. The match itself is not shown.';
  if (finding.kind === 'line' && !matchesAny(finding.path, patterns)) {
    return `::error file=${prop(finding.path)},line=${finding.line}::${msg}`;
  }
  return `::error::${format(finding, patterns)}: ${msg}`;
}

// ── Running git ──────────────────────────────────────────────────────────────

function git(args, { buffer = false } = {}) {
  return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
    encoding: buffer ? 'buffer' : 'utf8',
    maxBuffer: 1 << 30,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function hasCommit(ref) {
  try {
    git(['cat-file', '-e', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function readPr({ base, head, branch, title, body }) {
  const range = `${base}...${head}`;
  const diffArgs = ['--no-color', '--no-ext-diff', '--no-textconv', '--find-renames'];
  return {
    added: parseAddedLines(git(['diff', ...diffArgs, '--unified=0', range])),
    newPaths: parseNewPaths(git(['diff', ...diffArgs, '--name-status', '-z', range])),
    binaries: parseBinaryPaths(git(['diff', ...diffArgs, '--numstat', '-z', range])),
    commits: parseCommits(git(['log', '-z', '--format=%H%n%B', `${base}..${head}`])),
    branch,
    title,
    body,
  };
}

function readTrackedFile(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return null; // tracked but missing from this working tree
  }
  if (stat.isSymbolicLink()) return { text: readlinkSync(path) };
  if (!stat.isFile()) return null;
  const buffer = readFileSync(path);
  return isBinary(buffer) ? { binary: true } : { text: buffer.toString('utf8') };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { mode: null, base: null, head: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pr' || a === '--tree') opts.mode = a.slice(2);
    else if (a === '--base') opts.base = argv[++i];
    else if (a === '--head') opts.head = argv[++i];
    else return { error: `unknown argument: ${a}` };
  }
  if (!opts.mode) return { error: 'choose a mode: --pr or --tree' };
  return opts;
}

function summary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  } catch {
    // A summary is a convenience; the exit code is the verdict.
  }
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const inActions = env.GITHUB_ACTIONS === 'true';
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`check-forbidden-terms: ${opts.error}`);
    return 2;
  }

  const { patterns, invalidLines } = parseTerms(env.FORBIDDEN_TERMS);
  if (invalidLines.length) {
    console.error(
      `check-forbidden-terms: FORBIDDEN_TERMS line(s) ${invalidLines.join(', ')} ` +
        'are not valid regular expressions. Fix the secret; the lines are not printed here.',
    );
    return 2;
  }
  if (!patterns.length) {
    const why =
      'FORBIDDEN_TERMS is not set (or holds no terms), so nothing was checked. ' +
      'A fork PR gets no secrets; the scan of main after the merge covers it.';
    console.log(inActions ? `::notice title=Forbidden-terms guard skipped::${why}` : `check-forbidden-terms: ${why}`);
    return 0;
  }

  let findings;
  let scanned;
  let binaries;
  if (opts.mode === 'pr') {
    const base = opts.base || env.BASE_SHA;
    const head = opts.head || env.HEAD_SHA;
    if (!base || !head) {
      console.error('check-forbidden-terms: --pr needs BASE_SHA and HEAD_SHA (or --base and --head)');
      return 2;
    }
    for (const [label, ref] of [['base', base], ['head', head]]) {
      if (!hasCommit(ref)) {
        console.error(`check-forbidden-terms: the ${label} commit is not in this clone (check out with fetch-depth: 0)`);
        return 2;
      }
    }
    const pr = readPr({ base, head, branch: env.HEAD_REF, title: env.PR_TITLE, body: env.PR_BODY });
    findings = prFindings(pr, patterns);
    binaries = pr.binaries.length;
    scanned = `${pr.added.length} added line(s), ${pr.newPaths.length} new path(s), ${pr.commits.length} commit message(s), the branch name, title and body`;
  } else {
    const paths = git(['ls-files', '-z']).split('\0').filter(Boolean);
    findings = [];
    binaries = 0;
    for (const path of paths) {
      const content = readTrackedFile(path);
      if (content?.binary) binaries++;
      findings.push(...fileFindings(path, content, patterns));
    }
    scanned = `${paths.length} tracked path(s)`;
  }

  const lines = findings.map((f) => format(f, patterns));
  for (const line of lines) console.log(line);
  if (inActions && opts.mode === 'pr') for (const f of findings) console.log(annotation(f, patterns));

  const verdict = findings.length
    ? `${findings.length} finding(s): a term from the FORBIDDEN_TERMS list appears at the location(s) above. The matched text is never printed.`
    : 'no forbidden term found.';
  console.error(`check-forbidden-terms --${opts.mode}: scanned ${scanned}; ${binaries} unscannable binary file(s); ${verdict}`);
  summary([
    `### Forbidden terms (--${opts.mode})`,
    '',
    `Scanned ${scanned}; ${binaries} unscannable binary file(s).`,
    '',
    findings.length ? `**${findings.length} finding(s)** (locations only):` : 'No forbidden term found.',
    ...lines.map((l) => `- \`${l.replace(/`/g, "'")}\``),
  ]);
  return findings.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = main();
  } catch (err) {
    // A git failure, most likely. Its message names a command, not a term.
    console.error(`check-forbidden-terms: ${err?.message?.split('\n')[0] ?? 'failed'}`);
    process.exitCode = 2;
  }
}
