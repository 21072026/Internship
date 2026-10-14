## 2026-10-13 — what CI costs now that the repo is private (#2910)

- **Measure Actions spend from the org billing report. Don't trust the run timing API.**
  `gh api repos/<o>/<r>/actions/runs/<id>/timing` now answers `billable.UBUNTU.total_ms: 0` for
  every run, including runs made after the repo went private. The old
  `orgs/<org>/settings/billing/actions` endpoint answers `410 This endpoint has been moved`.
  What works with the default `gh` token (no `admin:org`) is
  `gh api "/organizations/<org>/settings/billing/usage?year=2026&month=10&day=12"`. It gives
  minutes per SKU (`Actions Linux`, `Actions Linux ARM`) per day. It also lists public-era
  minutes, with `discountAmount == grossAmount`, so you can see what the old cadence would
  have cost.
- **For a per-workflow split, use the jobs API and round each hosted job up to a whole
  minute.** `gh api "repos/<o>/<r>/actions/runs/<id>/jobs?filter=all"` returns
  `started_at`/`completed_at`, `labels` and `runner_group_name`. `"GitHub Actions"` means
  hosted. Our self-hosted runner reports `"Default"` and costs nothing. A reusable workflow's
  jobs (`build-image.yml`) appear under the caller's run. Skipped jobs have no runner and cost
  nothing. Sum the result, then check it against the billing report for the same days.
- **Count real runs. The cron line does not tell you how often a job runs.** `uptime.yml` says
  `*/5 * * * *`, which would be 288 runs a day. GitHub actually started it about 5.5 times a
  day. `mysql-watchdog.yml` (`*/10`) and `runner-watchdog.yml` (`*/15`) got the same ~5.5, 170
  runs each in 30 days. So `gh run list --created ">=…"` is the only honest count, and the
  three together cost ~500 min/month, not the ~16,000 their cron lines suggest.
- **Size CI cost per merge, not per workflow.** One merge to `main` here starts `ci.yml`,
  `e2e.yml`, `security-audit.yml` and two image builds (prod and preview, two arches each), about
  50 hosted minutes. At ~335 merges a month, that alone is ~8× the Free plan's 2,000 minutes, so
  trimming schedules cannot close the gap.
- **`gh run list --limit 2000` on a busy workflow takes minutes.** It pages 100 runs at a time,
  and `ci.yml` had 830 runs in 30 days. Run the collection in the background and write each
  workflow's result to its own file, so a stopped run can resume.
- **arm64 hosted runners are not free in a private repo.** Since the 2026-01-29 changelog,
  `ubuntu-24.04-arm` works in private repos and draws from the same included-minutes pool as
  x64, at $0.005/min against $0.006. It also gets 2 vCPUs instead of the 4 that public repos
  get.

## 2026-10-14 — applying the cadence package (#2917)

- **Before you drop a trigger, list every step that runs only on that trigger.** `e2e.yml`
  saved the Next.js build cache only under `github.event_name == 'push'`. Removing
  `push: main` would have left the PR gate with no cache writer, so every PR build would have
  started cold and cost more minutes. `grep -n "event_name\|github.ref ==" .github/workflows/*.yml`
  finds them. The save moved to shard 1 of the daily `e2e-full` run, which runs on `main`, so
  PR branches can read the cache it writes.
- **Each 1-minute helper job costs a full minute on every run.** At ~1,040 image builds a month,
  `build-image.yml`'s "resolve inputs" and "publish manifest" jobs were ~2,000 minutes on their
  own. When a matrix shrinks to one leg, fold its fan-in and fan-out jobs back into it. For the
  same reason, the smoke gate is one job named `Playwright smoke` again, not a matrix plus an
  aggregator.
