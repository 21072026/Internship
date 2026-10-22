## 2026-10-22 — the self-hosted runner died of an OOM and nobody noticed for a day (#3108)

- **"Queued for hours" on every self-hosted job is a dead runner, not a slow one.** Look at the
  newest *finished* self-hosted job: here it was a `Deploy preview` run whose `docker run --rm …
  npx prisma db push` step ended with exit 137 ("Running generate…") — the kernel's OOM killer.
  After that the runner took no job at all. The proxy in this container refuses the
  `/actions/runners` API, so read the run/job lists instead (`status=queued`, then each run's
  jobs and their `runner_name`).
- **A watchdog that picks "the first unit matching a glob" watches whichever repo sorts first.**
  The box hosts runners for several repositories; `runner-watchdog.yml` took
  `actions.runner.*` | `head -1`, found another repo's healthy runner and reported OK all day.
  Select by runner name, and test liveness by *what the runner does* (does its queue drain?),
  not by `systemctl is-active`.
- **`prisma db push` regenerates the client unless told not to.** In a container whose image
  already ran `prisma generate` at build time, that is pure memory spent at the worst moment —
  pass `--skip-generate` on the server.
- **A full server should be a message, not a crash.** Topic environments now pass a memory
  admission check first (`infra/server/capacity.sh`); a deferred one ends green with a
  "server is busy" PR comment. Keep the verdict functions pure (numbers in, one line out) so a
  bash test can pin them without docker.
- **Archiving a stream session releases its container: unpushed work is gone.** Before
  `archive_session`, make the stream push a WIP branch, and check `git log origin/<branch>`
  yourself.
- **A coordinator's interrupt reads like the maintainer's stop.** Streams that receive an
  interrupt plus a peer message may refuse further work "until the maintainer confirms";
  quote the maintainer's own words verbatim when you relay an instruction.
