## 2026-10-29 — off-site backup check and drill (#2058), JSON body limit (#3210)

- **Read the tree before building what an issue asks for.** #2058 (written 2026-08) asked for
  an encrypted off-site copy; `infra/server/backup-offsite.sh` + `backup-offsite-setup.yml`
  (restic → R2, #2169) had shipped since. The real gap was the *witness* (a hosted-runner
  check) and the off-site drill, not the upload.
- **Give an infra script a test seam instead of skipping its test.** `check-backups-offsite.sh`
  takes `SNAPSHOTS_JSON` + `NOW_EPOCH`; the drill test puts fake `restic`/`mysql` on `PATH` and
  asserts no call happened when a guard refuses. Both run in seconds in `ci.yml`.
- **restic writes nanosecond timestamps**; Python's `datetime.fromisoformat` takes six
  fractional digits — trim before parsing or every snapshot list reads as garbage.
- **Middleware sees headers, not bodies.** A `Content-Length` cap in `src/middleware.ts` stops
  declared oversized JSON; a chunked body still reaches `request.json()` — say so and leave
  the proxy cap (`request_body`) as an operator runbook, rather than claiming a full fix.
