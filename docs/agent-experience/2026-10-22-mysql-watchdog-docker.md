## 2026-10-22 — the MySQL watchdog meets the Docker host (#3135)

- **Moving a secret moves every workflow that reads it.** The `SSH_*` secrets were repointed
  from the retired Plesk box to the Caddy/Docker host for `runner-watchdog.yml`; two more
  workflows read them and still assumed Plesk (`mysql-watchdog.yml` looked for a systemd
  MySQL unit, `infra-setup.yml` for nginx). Before moving one, `grep -rn 'secrets.SSH_'
  .github/workflows` and decide each consumer's fate in the same change.
- **A global OOM kill leaves Docker's `OOMKilled` at `false`.** The flag reports a kill by the
  container's own memory limit only; `internship-mysql` has none, so the kernel's host-wide
  killer took mysqld and Docker recorded nothing unusual (`RestartCount` +1, that's all). The
  record is `journalctl -k`: `Killed process <pid> (mysqld)`.
- **Under `restart: unless-stopped` a watchdog that restarts the database only makes things
  worse.** Docker already restarts a crash (9 s on 2026-10-21), leaves a `docker stop` alone on
  purpose (a restore or migration may be running), and a running-but-silent mysqld is usually
  InnoDB recovering. The useful remainder is alerting and evidence, from off the box.
- **Never a bare `docker inspect` in anything whose output reaches a log.** The MySQL
  container's healthcheck carries `-p${MYSQL_ROOT_PASSWORD}` on its command line; the watchdog
  log and its alert issue are public. Ask for named fields with `--format`; the test pins it
  with a stub that answers an unformatted inspect with a canary password.
- **Pin "never does X" by recording verbs, then mutate.** The test's `docker` stub writes each
  call's first word to a file and asserts nothing but `inspect`/`logs` appears. Injecting a
  `docker start` into a copy of the script made those checks fail. Run the test suite against
  that kind of mutant, or the assertion may be vacuous.
- **`gh workflow run <file> --ref <branch>` proves an infra change against the real box before
  merge.** It runs the branch's workflow file *and* the scripts it checks out, so a scheduled
  job that SSHes into prod can be shown green before `main` ever schedules it.
- **This Mac's GateGuard hook blocks `rm -rf` even inside the scratchpad**, and repeats the
  block after the facts are given. A fresh `mktemp -d` under the scratchpad avoids the delete
  altogether.
