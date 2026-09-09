#!/usr/bin/env node
// The failure trail for release-compact.yml (#2323).
//
// WHY THIS EXISTS
//   Compaction does its job and then cannot deliver it: the branch is pushed
//   and correct, and `gh pr create` is refused with "GitHub Actions is not
//   permitted to create or approve pull requests". Four scheduled runs in a
//   row ended that way and nobody noticed for three days — the workflow did
//   print a good message, but only inside a log nobody opens, and the alert
//   e-mail that should have flagged it is separately broken (#2322).
//
//   So the trail has to be somewhere a person actually walks past. A workflow
//   that cannot open a pull request CAN open an issue, with no new secret and
//   no new permission beyond `issues: write`. That is what this script does:
//   it opens — or, on the next failed run, UPDATES — one issue carrying the
//   branch, the fragment count, the version the compaction would ship and the
//   exact manual step, and it closes that issue again as soon as a compaction
//   PR exists.
//
//   Updating instead of duplicating is the load-bearing part: this workflow
//   fires daily, so "open an issue on failure" without the lookup would be 30
//   identical issues in a month — its own kind of silence.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   It does not try to get the PR created. Which credential Actions may use to
//   open a pull request is a repository permission decision for the
//   maintainer, asked in #2323; this script only makes the failure impossible
//   to miss.
//
// USAGE (from the workflow; every input is an env var Actions already sets)
//   node scripts/release-compact-alert.mjs stuck
//   node scripts/release-compact-alert.mjs resolved
//
//   COMPACT_BRANCH  branch that holds the compaction commit
//   COUNT           fragments folded into it
//   VERSION         version those fragments ship as
//   PR_NUMBER       the compaction PR (resolved mode only)
//   GH_TOKEN        needs `issues: write`. The workflow grants that to its own
//                   GITHUB_TOKEN; if RELEASE_BOT_TOKEN is set instead and that
//                   PAT lacks the scope, every gh call here fails and the
//                   script degrades to the annotation alone — which is also
//                   the case where PR creation worked and none of this ran.
//   plus GITHUB_REPOSITORY / GITHUB_SERVER_URL / GITHUB_RUN_ID
//
// Pure message/state helpers are exported and unit-tested in
// scripts/test/release-compact-alert.test.mjs — the text a human reads is the
// whole point of the script, so it is not left untested inside a YAML file.

import { execFileSync } from 'node:child_process';

/** One issue per outage: found by this label, never by title matching. */
export const ALERT_LABEL = 'release-compact-stuck';

/** The maintainer decides the repo setting that fixes this for good (#2323).
 *  Named in the body on purpose: a warning nobody is accountable for is a
 *  warning nobody acts on. */
export const MAINTAINER = '@mersahin';

/** Machine-readable tail of the issue body, so a later run can tell whether
 *  anything actually changed and stay quiet when it did not. */
const STATE_RE = /<!--\s*release-compact-alert:\s*version=(\S+)\s+count=(\d+)\s*-->/;

/** Read the state a previous run stamped into the issue body. */
export function parseState(body) {
  const match = STATE_RE.exec(body || '');
  if (!match) return null;
  return { version: match[1], count: Number(match[2]) };
}

/** Comment only when the situation moved. The body is refreshed every run, but
 *  a comment is a notification, and a daily "still stuck, same numbers" ping
 *  is how an alert gets muted. */
export function shouldComment(previous, current) {
  if (!previous) return false;
  return previous.version !== current.version || previous.count !== Number(current.count);
}

/** URL that opens the pull request the workflow could not open — the whole
 *  manual step is clicking it and pressing the green button. */
export function compareUrl({ serverUrl, repo, branch }) {
  return `${serverUrl}/${repo}/compare/main...${encodeURIComponent(branch)}?expand=1`;
}

export function buildStuckIssue(ctx) {
  const { branch, count, version, repo, serverUrl, runUrl } = ctx;
  const title = `📓 Release compaction is stuck — ${count} fragment(s) waiting on a PR (${version})`;
  const body = [
    '`release-compact.yml` folded the pending release fragments and force-pushed them, then could',
    '**not open the pull request**: GitHub Actions is not permitted to create pull requests in this',
    'repository.',
    '',
    '**Nothing is lost and nothing needs rebuilding** — the branch is correct and current. The only',
    'missing step is the PR.',
    '',
    '| | |',
    '|---|---|',
    `| Branch | \`${branch}\` |`,
    `| Fragments compacted | ${count} |`,
    `| Version they ship as | \`${version}\` |`,
    `| Last failed run | ${runUrl} |`,
    '',
    '### Open it by hand (this is the whole fix for today)',
    '',
    compareUrl({ serverUrl, repo, branch }),
    '',
    'Then merge it like any other PR. Every later failed run force-pushes the same branch with an',
    'up-to-date compaction, so opening it late is never wrong — compaction always folds *everything*',
    'pending.',
    '',
    '### Make it stop happening',
    '',
    `That takes a repository setting, and an agent must not change one — ${MAINTAINER} picks between the`,
    'two options in #2323 (allow Actions to create pull requests, or add a `RELEASE_BOT_TOKEN` secret).',
    '',
    '### Why an issue and not just a log line',
    '',
    'This failure was invisible for three days: the run log said exactly the right thing, and nobody',
    'opens a run log for a workflow that has always been green. The alert e-mail that should have',
    'caught it is separately broken (#2322). This issue is **updated in place** by every failed run',
    'and **closed automatically** as soon as a compaction PR is open again, so it says one true thing',
    'at a time.',
    '',
    "While it is open, `CHANGELOG.md`, `src/lib/releaseNotes.ts` and `package.json`'s version stop",
    'recording what shipped. The version the app *displays* stays correct — the build derives it from',
    'base+fragments (`releases/README.md`).',
    '',
    `<!-- release-compact-alert: version=${version} count=${count} -->`,
  ].join('\n');
  return { title, body };
}

/** Single-line `::error::` carrying the same content, so the run summary shows
 *  it without anyone opening the log. `%0A` is how an annotation gets a line
 *  break. */
export function buildAnnotation(ctx) {
  const { branch, count, version, repo, serverUrl, issueUrl } = ctx;
  const lines = [
    `The branch ${branch} is pushed and correct (${count} fragment(s) -> ${version}), but creating the PR failed:`,
    'GitHub Actions is not permitted to create pull requests in this repository.',
    `Open it in one click: ${compareUrl({ serverUrl, repo, branch })}`,
    issueUrl
      ? `Tracked in ${issueUrl} — that issue closes itself when a compaction PR exists.`
      : 'Could not record it as an issue either (the token needs issues: write) — see #2323.',
    `The permanent fix is a repository setting for ${MAINTAINER}, asked in #2323: allow Actions to create PRs, or add RELEASE_BOT_TOKEN.`,
  ];
  return `::error title=Release compaction could not open its PR::${lines.join('%0A')}`;
}

// ── the gh plumbing ─────────────────────────────────────────────────────────

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim();
}

function findOpenAlert(repo) {
  const raw = gh([
    'issue',
    'list',
    '--repo',
    repo,
    '--label',
    ALERT_LABEL,
    '--state',
    'open',
    '--limit',
    '1',
    '--json',
    'number,body',
  ]);
  const [first] = JSON.parse(raw || '[]');
  return first || null;
}

function ensureLabel(repo) {
  try {
    gh([
      'label',
      'create',
      ALERT_LABEL,
      '--repo',
      repo,
      '--color',
      'D93F0B',
      '--description',
      'release-compact.yml pushed a branch but could not open its PR (#2323)',
    ]);
  } catch {
    // Already exists, or labels are not writable — neither is worth failing on.
  }
}

function context() {
  const repo = process.env.GITHUB_REPOSITORY || '';
  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const runId = process.env.GITHUB_RUN_ID || '';
  return {
    repo,
    serverUrl,
    runUrl: runId ? `${serverUrl}/${repo}/actions/runs/${runId}` : '(no run id)',
    branch: process.env.COMPACT_BRANCH || 'bot/release-compact',
    count: process.env.COUNT || '?',
    version: process.env.VERSION || '(version not resolved)',
  };
}

function reportStuck() {
  const ctx = context();
  let issueUrl = null;

  // The annotation must survive a failure in here, so every gh call is
  // best-effort and the annotation is printed last, with whatever we got.
  try {
    ensureLabel(ctx.repo);
    const { title, body } = buildStuckIssue(ctx);
    const existing = findOpenAlert(ctx.repo);
    if (existing) {
      gh([
        'issue',
        'edit',
        String(existing.number),
        '--repo',
        ctx.repo,
        '--title',
        title,
        '--body',
        body,
      ]);
      issueUrl = `${ctx.serverUrl}/${ctx.repo}/issues/${existing.number}`;
      if (shouldComment(parseState(existing.body), ctx)) {
        gh([
          'issue',
          'comment',
          String(existing.number),
          '--repo',
          ctx.repo,
          '--body',
          `Still stuck, and the backlog moved: now ${ctx.count} fragment(s) -> \`${ctx.version}\`. Run: ${ctx.runUrl}`,
        ]);
      }
      console.log(`updated ${issueUrl}`);
    } else {
      issueUrl = gh([
        'issue',
        'create',
        '--repo',
        ctx.repo,
        '--label',
        ALERT_LABEL,
        '--title',
        title,
        '--body',
        body,
      ]);
      console.log(`opened ${issueUrl}`);
    }
  } catch (error) {
    console.log(
      `::warning title=Could not record the compaction failure as an issue::${error.message} — the error annotation below is the only trail this run leaves.`
    );
  }

  console.log(buildAnnotation({ ...ctx, issueUrl }));
}

function reportResolved() {
  const ctx = context();
  const pr = process.env.PR_NUMBER || '';
  try {
    const existing = findOpenAlert(ctx.repo);
    if (!existing) return;
    const note = pr
      ? `A compaction PR is open again (#${pr}), so this is no longer stuck.`
      : 'A compaction PR is open again, so this is no longer stuck.';
    gh(['issue', 'close', String(existing.number), '--repo', ctx.repo, '--comment', note]);
    console.log(`closed #${existing.number} (${ALERT_LABEL})`);
  } catch (error) {
    // A stale open alert is untidy, not broken; never fail a good compaction
    // over housekeeping.
    console.log(`::warning title=Could not close the stale compaction alert::${error.message}`);
  }
}

const [mode] = process.argv.slice(2);
if (mode === 'stuck') reportStuck();
else if (mode === 'resolved') reportResolved();
else if (mode) {
  console.error(`unknown mode "${mode}" — expected "stuck" or "resolved"`);
  process.exit(2);
}
