#!/usr/bin/env node
// Is the self-hosted runner draining its queue? — run by the Runner Watchdog
// (.github/workflows/runner-watchdog.yml) on a GitHub-HOSTED runner.
//
// Why: "the runner service is active" is not "the runner takes jobs". On
// 2026-10-21 a deploy was OOM-killed on the box; afterwards the runner took no
// job for a day while every deploy queued behind it, and the watchdog — which
// only asked systemd — kept reporting OK. This asks GitHub instead: jobs for
// the runner's label have been waiting long, and nothing is running on the
// runner → it is stuck, and the watchdog restarts it.
//
// The rule is pure (runnerStuckVerdict) and unit-tested in
// scripts/test/runner-queue.test.mjs. The CLI below only fetches; any API
// failure answers "not stuck", because a restart is never the safe default.
//
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, WATCHED_RUNNER, WATCHED_LABEL,
//      STUCK_AFTER_MIN (default 30), GITHUB_OUTPUT (stuck=true|false).

/**
 * @param {{ queuedJobs: Array<{ labels?: string[], created_at: string }>,
 *           runningJobs: Array<{ runner_name?: string | null }>,
 *           runnerName: string, label: string, now: number, stuckAfterMin: number }} input
 * @returns {{ stuck: boolean, reason: string }}
 */
export function runnerStuckVerdict({ queuedJobs, runningJobs, runnerName, label, now, stuckAfterMin }) {
  const mine = queuedJobs.filter((j) => (j.labels ?? []).includes(label));
  if (mine.length === 0) return { stuck: false, reason: `no job is waiting for '${label}'` };
  const oldest = Math.min(...mine.map((j) => Date.parse(j.created_at)).filter(Number.isFinite));
  if (!Number.isFinite(oldest)) return { stuck: false, reason: 'queued jobs carry no usable timestamp' };
  const waitedMin = Math.floor((now - oldest) / 60_000);
  // A long job (a backup drill, a slow deploy) legitimately holds the queue: a
  // runner that is executing something is not stuck, however long others wait.
  if (runningJobs.some((j) => j.runner_name === runnerName)) {
    return { stuck: false, reason: `${runnerName} is running a job; the oldest of ${mine.length} queued job(s) has waited ${waitedMin} min` };
  }
  if (waitedMin < stuckAfterMin) {
    return { stuck: false, reason: `the oldest of ${mine.length} queued job(s) has waited ${waitedMin} min (< ${stuckAfterMin})` };
  }
  return {
    stuck: true,
    reason: `${mine.length} job(s) for '${label}' are queued, the oldest for ${waitedMin} min, and nothing is running on ${runnerName}`,
  };
}

async function api(path) {
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}

async function jobsOfRuns(status) {
  const { workflow_runs: runs = [] } = await api(`/actions/runs?status=${status}&per_page=100`);
  const jobs = [];
  for (const run of runs) {
    const { jobs: list = [] } = await api(`/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
    jobs.push(...list);
  }
  return jobs;
}

async function main() {
  const runnerName = process.env.WATCHED_RUNNER ?? '';
  const label = process.env.WATCHED_LABEL || 'self-hosted';
  const stuckAfterMin = Number(process.env.STUCK_AFTER_MIN) > 0 ? Number(process.env.STUCK_AFTER_MIN) : 30;
  let verdict;
  try {
    // A queued job may sit in a run that is queued or already in progress
    // (its other jobs done), so both lists are read.
    const all = [...(await jobsOfRuns('queued')), ...(await jobsOfRuns('in_progress'))];
    verdict = runnerStuckVerdict({
      queuedJobs: all.filter((j) => j.status === 'queued'),
      runningJobs: all.filter((j) => j.status === 'in_progress'),
      runnerName,
      label,
      now: Date.now(),
      stuckAfterMin,
    });
  } catch (err) {
    verdict = { stuck: false, reason: `could not read the queue (${err.message}) — not restarting` };
  }
  console.log(`${verdict.stuck ? 'STUCK' : 'ok'}: ${verdict.reason}`);
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_OUTPUT, `stuck=${verdict.stuck}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
