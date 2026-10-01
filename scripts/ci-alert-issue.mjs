#!/usr/bin/env node
// A failure channel for the scheduled safety nets that needs no SMTP (#2322).
//
// WHY THIS EXISTS
//   e2e-full, k6-load, stress and backup-verify are all silent when green by
//   design, and each tells a person about a red run by e-mail. From a
//   GitHub-hosted runner that e-mail does not leave: the send dies on
//   `ETIMEDOUT` at `CONN` — the TCP connection to the SMTP host never opens
//   (auth is never reached, and an unset host would fail fast on localhost
//   instead). A broken mailer plus "green is silent" means a red net and a
//   healthy repo look identical.
//
//   A workflow can always open an issue: no port, no secret, only
//   `issues: write` on its own GITHUB_TOKEN. GitHub then notifies the people
//   watching the repo, and the issue is a durable trace even when every
//   notification channel is down. release-compact.yml proved the shape
//   (`scripts/release-compact-alert.mjs`, #2323); this is the same idea for
//   every other net, with one rule set instead of four.
//
// THE RULES
//   * One open issue per net, found by the `ci-alert` label plus the key in a
//     hidden marker — never by title, which a human may edit.
//   * `red` opens it, or refreshes its body in place. It COMMENTS only when the
//     signature moved (e2e-full passes the commit sha, the others the UTC day),
//     so a net that fires four times a day on the same broken commit pings once,
//     not four times — a daily "still red, same thing" is how alerts get muted.
//   * `green` closes it with a link to the green run. A net that recovered on
//     its own must not leave an alarm standing.
//   * Best effort, always: a failure in here prints a warning and exits 0. The
//     job's own red status is untouched either way; this only adds a trail.
//
// USAGE (from a workflow step; every input is an env var)
//   node scripts/ci-alert-issue.mjs red|green
//
//   ALERT_KEY        which net, e.g. `e2e-full` ([a-z0-9-], required)
//   ALERT_TITLE      human title for the issue (red only)
//   ALERT_SUMMARY    markdown: what failed and where to look (red only)
//   ALERT_SIGNATURE  optional; a comment is posted only when it changes.
//                    Defaults to the UTC day.
//   GH_TOKEN         needs `issues: write`
//   plus GITHUB_REPOSITORY / GITHUB_SERVER_URL / GITHUB_RUN_ID
//
// The pure helpers are exported and unit-tested in
// scripts/test/ci-alert-issue.test.mjs.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const ALERT_LABEL = 'ci-alert';

/** Named in the body of a NEW issue, so its creation is a notification even
 *  for someone who does not watch the repository. */
export const MAINTAINER = '@mersahin';

const KEY_RE = /^[a-z0-9-]{1,40}$/;
const STATE_RE = /<!--\s*ci-alert:\s*key=([a-z0-9-]+)\s+sig=(\S+)\s+reds=(\d+)\s*-->/;

export function isValidKey(key) {
  return typeof key === 'string' && KEY_RE.test(key);
}

/** The state a previous run stamped into the issue body, or null. */
export function parseState(body) {
  const match = STATE_RE.exec(body || '');
  if (!match) return null;
  return { key: match[1], sig: match[2], reds: Number(match[3]) };
}

/** The open alert for this net among `issues` ({ number, body }[]), if any. */
export function pickIssue(issues, key) {
  return (issues || []).find((issue) => parseState(issue.body)?.key === key) || null;
}

/** Signatures go into an HTML comment and a regex, so no whitespace and no
 *  `--`; anything else is kept as given. */
export function normaliseSignature(sig, now = new Date()) {
  const cleaned = String(sig || '').trim().replace(/\s+/g, '_').replace(/-{2,}/g, '-');
  return cleaned || now.toISOString().slice(0, 10);
}

export function shouldComment(previous, sig) {
  return !!previous && previous.sig !== sig;
}

export function buildIssue({ key, title, summary, sig, reds, runUrl, isNew }) {
  const body = [
    `The scheduled **${key}** run is red.`,
    '',
    summary || '_No summary was passed — open the run for details._',
    '',
    '| | |',
    '|---|---|',
    `| Latest red run | ${runUrl} |`,
    `| Red runs since this opened | ${reds} |`,
    '',
    'This issue is refreshed by every red run, gets a comment only when something new is red, and',
    '**closes itself on the next green run**. It exists because the alert e-mail cannot leave a',
    'GitHub-hosted runner (#2322) — this is the trail that does not depend on SMTP.',
    ...(isNew ? ['', `cc ${MAINTAINER}`] : []),
    '',
    `<!-- ci-alert: key=${key} sig=${sig} reds=${reds} -->`,
  ].join('\n');
  return { title: title || `🚨 ${key} is red`, body };
}

// ── the gh plumbing ─────────────────────────────────────────────────────────

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim();
}

function openAlerts(repo) {
  const raw = gh(['issue', 'list', '--repo', repo, '--label', ALERT_LABEL, '--state', 'open', '--limit', '50', '--json', 'number,body']);
  return JSON.parse(raw || '[]');
}

function ensureLabel(repo) {
  try {
    gh(['label', 'create', ALERT_LABEL, '--repo', repo, '--color', 'B60205', '--description', 'A scheduled safety net is red (#2322)']);
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
    key: process.env.ALERT_KEY || '',
    runUrl: runId ? `${serverUrl}/${repo}/actions/runs/${runId}` : '(no run id)',
  };
}

function reportRed(ctx) {
  const sig = normaliseSignature(process.env.ALERT_SIGNATURE);
  ensureLabel(ctx.repo);
  const existing = pickIssue(openAlerts(ctx.repo), ctx.key);
  const previous = existing ? parseState(existing.body) : null;
  const { title, body } = buildIssue({
    key: ctx.key,
    title: process.env.ALERT_TITLE,
    summary: process.env.ALERT_SUMMARY,
    sig,
    reds: (previous?.reds ?? 0) + 1,
    runUrl: ctx.runUrl,
    isNew: !existing,
  });
  if (!existing) {
    const url = gh(['issue', 'create', '--repo', ctx.repo, '--label', ALERT_LABEL, '--title', title, '--body', body]);
    console.log(`::error title=${ctx.key} is red::Tracked in ${url}`);
    return;
  }
  // Keep the "cc" line of the original body out of later refreshes: an edit
  // does not notify anyway, and the comment below is the ping.
  gh(['issue', 'edit', String(existing.number), '--repo', ctx.repo, '--title', title, '--body', body]);
  if (shouldComment(previous, sig)) {
    gh(['issue', 'comment', String(existing.number), '--repo', ctx.repo, '--body', `Red again, on something new (\`${sig}\`). Run: ${ctx.runUrl}`]);
  }
  console.log(`::error title=${ctx.key} is red::Tracked in #${existing.number}`);
}

function reportGreen(ctx) {
  const existing = pickIssue(openAlerts(ctx.repo), ctx.key);
  if (!existing) return;
  gh(['issue', 'close', String(existing.number), '--repo', ctx.repo, '--comment', `Green again: ${ctx.runUrl}`]);
  console.log(`closed #${existing.number} (${ctx.key})`);
}

function main() {
  const [mode] = process.argv.slice(2);
  const ctx = context();
  if (mode !== 'red' && mode !== 'green') {
    console.error(`unknown mode "${mode ?? ''}" — expected "red" or "green"`);
    process.exit(2);
  }
  if (!isValidKey(ctx.key)) {
    console.error(`ALERT_KEY must match ${KEY_RE} — got "${ctx.key}"`);
    process.exit(2);
  }
  try {
    if (mode === 'red') reportRed(ctx);
    else reportGreen(ctx);
  } catch (error) {
    console.log(`::warning title=Could not record ${ctx.key} as an issue::${String(error?.message || error).split('\n')[0]}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
