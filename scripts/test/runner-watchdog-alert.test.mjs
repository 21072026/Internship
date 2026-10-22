// The Runner Watchdog's red/green decision (scripts/runner-watchdog-alert.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerAlertVerdict, classifyError, cleanDetail, toCount } from '../runner-watchdog-alert.mjs';

const NOW = new Date('2026-10-22T12:00:00Z');
const base = { jobResult: 'success', runnerName: 'box', label: 'self-hosted', stuckAfterMin: '30', now: NOW };

test('stuck, then restarted and recovered → still RED: a stall happened', () => {
  const v = runnerAlertVerdict({
    ...base,
    stuck: 'true',
    queued: '7',
    waitedMin: '1740',
    outcome: 'recovered',
    detail: 'RECOVERED: stuck runner restarted.',
  });
  assert.equal(v.mode, 'red');
  assert.equal(v.kind, 'stalled_recovered');
  assert.match(v.title, /stalled and was restarted/);
  assert.match(v.summary, /Stuck for 1740 min \(~29 h\):\*\* 7 job\(s\) for the `self-hosted` label/);
  assert.match(v.summary, /RECOVERED: stuck runner restarted\./);
  // "active" after a restart is not proof the queue drains — the issue must not claim it.
  assert.match(v.summary, /"Active" is not "taking jobs"/);
  assert.doesNotMatch(v.summary, /should drain now|Nothing to do/);
  // A stall is news every time it comes back: per-run signature, so each one comments.
  assert.equal(v.signature, '2026-10-22.stalled_recovered.12:00');
  assert.equal(runnerAlertVerdict({ ...base, stuck: 'true', outcome: 'recovered', runId: '4711' }).signature, '2026-10-22.stalled_recovered.4711');
});

test('stuck but the box shows a job in flight (BUSY) → green: the box has the last word', () => {
  const v = runnerAlertVerdict({ ...base, stuck: 'true', outcome: 'busy', detail: 'BUSY: a job is running' });
  assert.equal(v.mode, 'green');
});

test('stuck with no verdict from the box → red, "not recovered"', () => {
  const v = runnerAlertVerdict({ ...base, jobResult: 'failure', stuck: 'true', queued: '2', waitedMin: '45', outcome: '' });
  assert.equal(v.mode, 'red');
  assert.equal(v.kind, 'stalled');
  assert.match(v.summary, /Not recovered/);
});

test('healthy runs are green: OK, not stuck; a runner started before anything waited long', () => {
  assert.equal(runnerAlertVerdict({ ...base, stuck: 'false', outcome: 'ok', detail: 'OK: runner service active and taking jobs.' }).mode, 'green');
  assert.equal(runnerAlertVerdict({ ...base, stuck: 'false', outcome: 'recovered' }).mode, 'green');
});

test('"could not read the queue" neither opens nor closes the alert', () => {
  // runner-queue.mjs answers stuck=unknown when the API fails; the box then only
  // checks is-active, so an "OK" here says nothing about the queue.
  assert.equal(runnerAlertVerdict({ ...base, stuck: 'unknown', outcome: 'ok' }).mode, 'skip');
  assert.equal(runnerAlertVerdict({ ...base, stuck: 'unknown', outcome: 'busy' }).mode, 'skip');
  // …but what the box itself reports still counts.
  const v = runnerAlertVerdict({ ...base, jobResult: 'failure', stuck: 'unknown', outcome: 'error', exitCode: '255' });
  assert.equal(v.mode, 'red');
  assert.equal(v.kind, 'unreachable');
});

test('error kinds keep one comment per day', () => {
  assert.equal(runnerAlertVerdict({ ...base, jobResult: 'failure', stuck: 'false', outcome: 'error', exitCode: '255', runId: '9' }).signature, '2026-10-22.unreachable');
});

test('box unreachable (ssh exit 255, nothing printed) → red', () => {
  const v = runnerAlertVerdict({ ...base, jobResult: 'failure', stuck: 'false', outcome: 'error', detail: '', exitCode: '255' });
  assert.equal(v.mode, 'red');
  assert.equal(v.kind, 'unreachable');
  assert.match(v.title, /does not answer over SSH/);
  assert.doesNotMatch(v.summary, /Stuck/);
});

test('no runner by that name on the box → red, says which knobs to check', () => {
  const v = runnerAlertVerdict({
    ...base,
    jobResult: 'failure',
    outcome: 'error',
    detail: 'ERROR: no runner named box on this box (no unit, no .runner file).',
    exitCode: '1',
  });
  assert.equal(v.kind, 'missing');
  assert.match(v.summary, /SSH_\*/);
  assert.match(v.summary, /RUNNER_NAME/);
});

test('restart failed → red, and an error wins over the stuck reading while still quoting it', () => {
  const v = runnerAlertVerdict({
    ...base,
    jobResult: 'failure',
    stuck: 'true',
    queued: '3',
    waitedMin: '90',
    outcome: 'error',
    detail: 'ERROR: runner not active after the restart.',
    exitCode: '1',
  });
  assert.equal(v.kind, 'restart_failed');
  assert.match(v.summary, /Stuck for 90 min:/);
  assert.match(v.summary, /Restart failed/);
});

test('a run that failed before the box answered → red "incomplete"; a cancelled one touches nothing', () => {
  assert.equal(runnerAlertVerdict({ ...base, jobResult: 'failure', stuck: 'false', outcome: '' }).kind, 'incomplete');
  assert.equal(runnerAlertVerdict({ ...base, jobResult: 'cancelled', stuck: '', outcome: '' }).mode, 'skip');
  assert.equal(runnerAlertVerdict({ ...base, jobResult: 'skipped' }).mode, 'skip');
  // A cancelled run that had already read "stuck" still alerts.
  assert.equal(runnerAlertVerdict({ ...base, jobResult: 'cancelled', stuck: 'true' }).kind, 'stalled');
});

test('the manual fix names the unit but never a host or user', () => {
  const v = runnerAlertVerdict({ ...base, jobResult: 'failure', outcome: 'error', exitCode: '255' });
  assert.match(v.summary, /ssh <user>@<host> 'sudo systemctl restart "actions\.runner\.\*\.box\.service"'/);
  assert.match(v.summary, /`SSH_\*` repository secrets/);
});

test('missing numbers (an output the runner dropped) fall back to the threshold, never a wrong number', () => {
  const v = runnerAlertVerdict({ ...base, stuck: 'true', outcome: 'recovered', queued: '', waitedMin: 'x' });
  assert.match(v.summary, /queued for 30\+ min/);
});

test('an odd runner name or label never reaches the markdown', () => {
  const v = runnerAlertVerdict({ ...base, runnerName: 'a`b; rm', label: 'x y', stuck: 'true', outcome: 'recovered' });
  assert.doesNotMatch(v.summary, /a`b|; rm|x y/);
  assert.match(v.summary, /the watched runner/);
  assert.match(v.summary, /actions\.runner\.\*\.<name>\.service/);
});

test('an unknown outcome value is treated as no verdict', () => {
  assert.equal(runnerAlertVerdict({ ...base, jobResult: 'failure', outcome: 'weird' }).kind, 'incomplete');
  assert.equal(runnerAlertVerdict({ ...base, outcome: 'weird' }).mode, 'green');
});

test('classifyError covers every ERROR line the watchdog prints', () => {
  const cases = [
    ['ERROR: restart of actions.runner.o-r.box.service failed', 'restart_failed'],
    ['ERROR: runner not active after the restart.', 'restart_failed'],
    ['ERROR: failed to start actions.runner.o-r.box.service', 'restart_failed'],
    ['ERROR: runner still not active after start.', 'restart_failed'],
    ['ERROR: could not start the runner. Recent run.sh log:', 'restart_failed'],
    ['ERROR: no runner named box on this box (no unit, no .runner file).', 'missing'],
    ["ERROR: unexpected WATCHED_RUNNER 'a b'", 'config'],
  ];
  for (const [detail, kind] of cases) assert.equal(classifyError({ detail, exitCode: 1 }), kind, detail);
  assert.equal(classifyError({ detail: '', exitCode: 255 }), 'unreachable');
  assert.equal(classifyError({ detail: '', exitCode: 1 }), 'failed');
  assert.equal(classifyError({ detail: '', exitCode: null }), 'failed');
});

test('cleanDetail and toCount', () => {
  assert.equal(cleanDetail('OK:\tfine `x`\r\n'), 'OK: fine x');
  assert.equal(cleanDetail('a'.repeat(500)).length, 200);
  assert.equal(cleanDetail(undefined), '');
  assert.equal(toCount('42'), 42);
  assert.equal(toCount(' 7 '), 7);
  assert.equal(toCount('-1'), null);
  assert.equal(toCount('3.5'), null);
  assert.equal(toCount(''), null);
});

test('the CLI writes mode, title, signature and a multi-line summary to GITHUB_OUTPUT', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'runner-alert-'));
  const out = path.join(dir, 'out');
  try {
    const script = fileURLToPath(new URL('../runner-watchdog-alert.mjs', import.meta.url));
    const run = (env) => {
      const res = spawnSync(process.execPath, [script], {
        env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, WATCHED_RUNNER: 'box', ...env },
        encoding: 'utf8',
      });
      assert.equal(res.status, 0, res.stderr);
      return res.stdout;
    };
    assert.match(run({ JOB_RESULT: 'failure', OUTCOME: 'error', EXIT_CODE: '255' }), /^red: unreachable/);
    const text = readFileSync(out, 'utf8');
    assert.match(text, /^mode=red$/m);
    assert.match(text, /^kind=unreachable$/m);
    assert.match(text, /^title=.*does not answer over SSH$/m);
    assert.match(text, /^signature=\d{4}-\d{2}-\d{2}\.unreachable$/m);
    const delimiter = /^summary<<(RUNNER_ALERT_[0-9a-f-]+)$/m.exec(text)?.[1];
    assert.ok(delimiter, 'heredoc-style summary output');
    assert.match(text, new RegExp(`Box unreachable[\\s\\S]*\\n${delimiter}\\n$`));
    assert.match(run({ JOB_RESULT: 'success', STUCK: 'false', OUTCOME: 'ok' }), /^green:/);
    assert.match(readFileSync(out, 'utf8'), /^mode=green$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
