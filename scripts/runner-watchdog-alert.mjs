#!/usr/bin/env node
// Red or green? — the Runner Watchdog's alert decision
// (.github/workflows/runner-watchdog.yml, job `alert`, on a GitHub-HOSTED runner).
//
// WHY THIS EXISTS
//   On 2026-10-21 the self-hosted runner died and every self-hosted job (both
//   deploys, every topic preview, the backup check) sat QUEUED for ~29 hours.
//   Nobody heard about it: a queued job never fails, so the deploys' own alert
//   jobs never ran, and the watchdog had no alert at all. This turns what the
//   watchdog saw into one `ci-alert` issue (scripts/ci-alert-issue.mjs — the
//   SMTP-free trail of #2322, the same one every other net uses), which cc's the
//   maintainer and so arrives as a GitHub notification e-mail.
//
// THE RULES (pure, unit-tested in scripts/test/runner-watchdog-alert.test.mjs)
//   RED when
//     * the queue step said stuck — jobs for the runner's label waited
//       RUNNER_STUCK_AFTER_MIN with nothing running on it — even when this very
//       run restarted the runner successfully: a stall happened, and the
//       maintainer wants to know that deploys sat still;
//     * the box step failed: the box did not answer over SSH, it hosts no
//       runner by that name, or the (re)start failed;
//     * the watchdog run failed before the box answered (a step timeout on a
//       box too busy to respond).
//   GREEN (the open issue closes itself) when the box said OK; when it said
//   BUSY — a live Runner.Worker beats the API's "stuck", exactly as it does for
//   the restart, because GitHub's filtered run listings come back empty now and
//   then; when nothing was stuck (a runner found stopped and started before any
//   job waited the threshold is not a stall).
//   SKIP (touch nothing) when the watchdog run was cancelled or skipped without
//   any verdict — a run cancelled by hand says nothing about the runner — and
//   when the queue could not be read (stuck=unknown) while the box answered
//   OK/BUSY: without the queue, "active" proves nothing, so an open stall issue
//   must not close on it (an ERROR from the box still counts).
//   A stall's signature is per run, so a stall that comes back after a restart
//   comments again; every other condition comments once per UTC day.
//
// Every input may be missing: the runner drops a job output that happens to
// contain a secret's value, so the summary falls back to the run link rather
// than to a wrong number.
//
// Env (all from the watchdog job's outputs): JOB_RESULT, STUCK, QUEUED,
//   WAITED_MIN, OUTCOME (ok|recovered|busy|error|unknown), DETAIL (the box's
//   verdict line), EXIT_CODE, WATCHED_RUNNER, WATCHED_LABEL, STUCK_AFTER_MIN,
//   GITHUB_RUN_ID (the runner's own, for the stall signature).
// Writes GITHUB_OUTPUT: mode=red|green|skip, kind, title, signature, summary.

import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const SETTLED = new Set(['ok', 'recovered', 'busy']);
const OUTCOMES = new Set([...SETTLED, 'error', 'unknown']);
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const LABEL_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/** A non-negative integer from an env string, or null. */
export function toCount(value) {
  const text = String(value ?? '').trim();
  return /^\d{1,7}$/.test(text) ? Number(text) : null;
}

/** The box's verdict line, safe to quote inside a markdown code span. */
export function cleanDetail(detail) {
  return String(detail ?? '')
    .replace(/[\u0000-\u001f\u007f`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** Which way the box step failed, from its last verdict line and ssh's exit code. */
export function classifyError({ detail, exitCode }) {
  if (/^ERROR: no runner named /.test(detail)) return 'missing';
  if (/^ERROR: unexpected WATCHED_RUNNER/.test(detail)) return 'config';
  if (/^ERROR: (restart of |failed to start |runner not active |runner still not active |could not start )/.test(detail)) {
    return 'restart_failed';
  }
  // ssh answers 255 for its own failures (no route, timeout, refused key) and
  // for a connection that drops mid-session; the box then printed nothing.
  if (!detail && exitCode === 255) return 'unreachable';
  return 'failed';
}

const TITLES = {
  stalled_recovered: '⚠️ runner-watchdog — the self-hosted runner stalled and was restarted',
  stalled: '🛑 runner-watchdog — the self-hosted runner is stuck',
  unreachable: "🛑 runner-watchdog — the runner's box does not answer over SSH",
  missing: '🛑 runner-watchdog — the box has no runner by that name',
  restart_failed: '🛑 runner-watchdog — the runner is down and the restart failed',
  config: '🛑 runner-watchdog — the watchdog could not check the runner',
  failed: '🛑 runner-watchdog — the watchdog could not check the runner',
  incomplete: '🛑 runner-watchdog — the watchdog could not check the runner',
};

function summaryFor(kind, { isStuck, queued, waitedMin, detail, exitCode, runner, label, stuckAfterMin }) {
  const name = runner ? `\`${runner}\`` : 'the watched runner';
  const quoted = detail ? ` (\`${detail}\`)` : '';
  const lines = [];

  if (isStuck) {
    const waited = waitedMin >= 120 ? `${waitedMin} min (~${Math.round(waitedMin / 60)} h)` : `${waitedMin} min`;
    lines.push(
      queued !== null && waitedMin !== null
        ? `**Stuck for ${waited}:** ${queued} job(s) for the \`${label}\` label are queued and nothing is running on ${name}.`
        : `**Stuck:** jobs for the \`${label}\` label have been queued for ${stuckAfterMin}+ min and nothing is running on ${name}.`,
    );
  }

  let firstMove;
  switch (kind) {
    case 'stalled_recovered':
      lines.push(
        `**Restarted:** this run restarted the runner and systemd reports it active again${quoted}.`,
        '"Active" is not "taking jobs": if this issue is still open after the next watchdog run, the restart did not drain the queue.',
      );
      firstMove = 'Watch the queued runs start. If the next watchdog run reports the stall again, look at the unit on the box (`journalctl -u` the unit), free memory and the box\'s outbound connection to GitHub; an OOM kill shows in `journalctl -k`.';
      break;
    case 'stalled':
      lines.push(`**Not recovered:** the restart step did not report a result${quoted}.`);
      firstMove = 'Open the run log; if jobs are still queued, restart the runner by hand.';
      break;
    case 'unreachable':
      lines.push(`**Box unreachable:** the watchdog could not hold an SSH session to the runner's box (ssh exit 255), so it could neither check nor restart ${name}.`);
      firstMove = 'Check that the box is up (provider console) and that the `SSH_*` secrets still point at it.';
      break;
    case 'missing':
      lines.push(`**Runner missing:** the box the \`SSH_*\` secrets reach has no runner named ${name} (no systemd unit, no \`.runner\` file).`);
      firstMove = 'Point the `SSH_*` secrets at the runner\'s box, or set the repository variable `RUNNER_NAME` to the name it was re-registered under.';
      break;
    case 'restart_failed':
      lines.push(`**Restart failed:** ${name} is down on the box and the watchdog could not bring it back${quoted}. The run log carries the unit's status.`);
      firstMove = 'Look at the unit on the box (`journalctl -u` the unit, free memory) before restarting it.';
      break;
    case 'config':
      lines.push('**Misconfigured:** the repository variable `RUNNER_NAME` holds characters the watchdog will not send to the box (letters, digits, `.`, `_`, `-` only).');
      firstMove = 'Fix `RUNNER_NAME`; the runner itself was not checked.';
      break;
    case 'incomplete':
      lines.push('**No verdict:** the watchdog run failed before the box answered (for example, the SSH step timed out on a box too busy to respond).');
      firstMove = 'Open the run log.';
      break;
    default: // failed
      lines.push(`**Check failed:** the step on the box ended with exit code ${exitCode ?? '?'} and no verdict line${quoted}.`);
      firstMove = 'Open the run log.';
  }

  lines.push(
    '',
    `**First move:** ${firstMove}`,
    `**Manual fix:** \`ssh <user>@<host> 'sudo systemctl restart "actions.runner.*.${runner || '<name>'}.service"'\` — user, host and port are the \`SSH_*\` repository secrets; see infra/README.md → "When the box is full".`,
  );
  if (isStuck) {
    lines.push('', '_GitHub starts the watchdog\'s `*/15` schedule late, often hours apart, so the stall may be older than this alert._');
  }
  return lines.join('\n');
}

/**
 * @param {{ jobResult?: string, stuck?: string | boolean, queued?: unknown, waitedMin?: unknown,
 *           outcome?: string, detail?: string, exitCode?: unknown,
 *           runnerName?: string, label?: string, stuckAfterMin?: unknown, runId?: string, now?: Date }} input
 * @returns {{ mode: 'red' | 'green' | 'skip', kind: string | null, title: string, signature: string,
 *             summary: string, reason: string }}
 */
const STALL_KINDS = new Set(['stalled', 'stalled_recovered']);

export function runnerAlertVerdict(input) {
  const jobResult = String(input.jobResult ?? '');
  const isStuck = input.stuck === true || input.stuck === 'true';
  // The queue step answers `unknown` when it could not read GitHub.
  const queueRead = isStuck || input.stuck === false || input.stuck === 'false';
  const outcome = OUTCOMES.has(input.outcome) ? input.outcome : '';
  const detail = cleanDetail(input.detail);
  const exitCode = toCount(input.exitCode);
  const facts = {
    isStuck,
    queued: toCount(input.queued),
    waitedMin: toCount(input.waitedMin),
    detail,
    exitCode,
    runner: NAME_RE.test(input.runnerName ?? '') ? input.runnerName : '',
    label: LABEL_RE.test(input.label ?? '') ? input.label : 'self-hosted',
    stuckAfterMin: toCount(input.stuckAfterMin) || 30,
  };
  const quiet = (mode, reason) => ({ mode, kind: null, title: '', signature: '', summary: '', reason });

  let kind;
  if (outcome === 'error') kind = classifyError({ detail, exitCode });
  else if (isStuck && outcome === 'busy') return quiet('green', 'the queue read stuck, but the box shows a job in flight (BUSY) — the box has the last word');
  else if (isStuck) kind = outcome === 'recovered' ? 'stalled_recovered' : 'stalled';
  else if (!queueRead && SETTLED.has(outcome)) return quiet('skip', 'the queue could not be read — neither opening nor closing the alert on a run that never saw it');
  else if (!SETTLED.has(outcome) && jobResult === 'failure') kind = 'incomplete';
  else if (!SETTLED.has(outcome) && jobResult !== 'success') return quiet('skip', `the watchdog run ended '${jobResult || 'unknown'}' without a verdict — touching nothing`);
  else return quiet('green', `not stuck, box said ${outcome || 'nothing readable'} (job ${jobResult || 'unknown'})`);

  const day = (input.now ?? new Date()).toISOString().slice(0, 10);
  return {
    mode: 'red',
    kind,
    title: TITLES[kind],
    // One comment per UTC day per condition: a box down for a day pings once,
    // a change of condition (unreachable → restart failed) pings again. A
    // stall is different — one that comes back after a restart is news every
    // time, so its signature is per run.
    signature: STALL_KINDS.has(kind) ? `${day}.${kind}.${input.runId || (input.now ?? new Date()).toISOString().slice(11, 16)}` : `${day}.${kind}`,
    summary: summaryFor(kind, facts),
    reason: kind,
  };
}

function main() {
  const env = process.env;
  let verdict;
  try {
    verdict = runnerAlertVerdict({
      jobResult: env.JOB_RESULT,
      stuck: env.STUCK,
      queued: env.QUEUED,
      waitedMin: env.WAITED_MIN,
      outcome: env.OUTCOME,
      detail: env.DETAIL,
      exitCode: env.EXIT_CODE,
      runnerName: env.WATCHED_RUNNER,
      label: env.WATCHED_LABEL,
      stuckAfterMin: env.STUCK_AFTER_MIN,
      runId: env.GITHUB_RUN_ID,
    });
  } catch (error) {
    // In doubt, alert: a decision that crashed must not read as "healthy".
    verdict = {
      mode: 'red',
      kind: 'failed',
      title: TITLES.failed,
      signature: `${new Date().toISOString().slice(0, 10)}.failed`,
      summary: `The alert could not evaluate the watchdog run (${String(error?.message || error).split('\n')[0]}). Open the run log.`,
      reason: 'decision crashed',
    };
  }
  console.log(`${verdict.mode}: ${verdict.reason}`);
  if (env.GITHUB_OUTPUT) {
    const delimiter = `RUNNER_ALERT_${randomUUID()}`;
    appendFileSync(
      env.GITHUB_OUTPUT,
      [
        `mode=${verdict.mode}`,
        `kind=${verdict.kind ?? ''}`,
        `title=${verdict.title}`,
        `signature=${verdict.signature}`,
        `summary<<${delimiter}`,
        verdict.summary,
        delimiter,
        '',
      ].join('\n'),
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
