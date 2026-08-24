# Disaster recovery — restoring the database

> Status: **runbook + automation**. The backup half is automated
> (`infra/backup-db.sh`, wired into every prod/preview deploy plus a daily cron
> — see [`infra/README.md`](../infra/README.md#5-database-backups--the-destructive-schema-gate)).
> That it is still *running* is checked daily by
> [`.github/workflows/backup-verify.yml`](../.github/workflows/backup-verify.yml)
> → `infra/check-backups.sh`, and the restore itself is rehearsed by
> `infra/restore-drill.sh`. This page is the human procedure behind both.
> Issue: #1183 · Epic: #1179.

A backup nobody has restored is a file, not a backup. This page exists so the
restore is a procedure you follow rather than one you invent at 2 a.m.

## What exists

| | |
|---|---|
| Location | `/var/backups/internship-crm` on the app server (`BACKUP_DIR`) |
| Naming | `<env>-<UTC stamp>.sql.gz` — e.g. `prod-20260806T2312Z.sql.gz` |
| Taken | before every prod/preview deploy, and daily at 03:15 UTC |
| Kept | `KEEP_DAYS` days (default 7) |
| Contents | a full `mysqldump` — **real personal data**: CVs, phone numbers, mentor notes |
| Permissions | files `0600`, directory `0700` |

`cat /var/backups/internship-crm/.last-prod` prints the newest dump's path.

## Restore

No timings are quoted here on purpose: the measured ones live in the drill log
at the bottom of this page, and the only number worth quoting is the one from a
drill against a real environment.

```bash
# 0. Decide WHICH dump. Newest is not always right: if the damage was a bad
#    schema push at 14:05, the dump taken at 14:04 by that same deploy is the
#    one you want.
ls -lt /var/backups/internship-crm/

# 1. Stop the app so nothing writes while you restore.
docker stop internship-crm

# 2. Load the secrets (never type the password on the command line).
set -a; . /etc/internship-crm/prod.env; set +a

# 3. Restore. This DROPs and recreates the tables in the dump.
gzip -dc /var/backups/internship-crm/prod-<stamp>.sql.gz \
  | mysql -h <host> -P <port> -u <user> -p <database>

# 4. Bring the schema up to the deployed code (additive only — the guard in
#    infra/schema-guard.sh still applies).
cd /path/to/Internship && ./infra/deploy-prod.sh --no-pull --skip-build

# 5. Start and verify.
docker start internship-crm
curl -sf http://127.0.0.1:3200/api/health | jq
```

Verify beyond the health check: sign in, open a mentee with a long interaction
history, and confirm the stage history and evaluations are there. `/api/health`
answering 200 only proves the app booted.

## Never do this

- **Do not restore a prod dump onto preview** to "test" it. Preview is shared
  and its data is seen by contributors — that is a data-protection incident, not
  a test. Restore into a scratch database (`internship_restore_test`) instead.
- **Do not repair prod with an ad-hoc `prisma db push`** after data loss. The
  push is what lost the data; running it again writes the new shape over what
  is left. Restore first, then deploy.
- **Do not delete the failing deploy's backup** while triaging. It is the only
  copy of the pre-damage state.
- **Do not copy a dump off the server** without a reason that survives being
  written down in the incident notes.

## Is the backup still alive?

A backup does not fail loudly. It stops — a cron entry lost in a server
rebuild, a deploy hook failing before the backup step, a full disk — and
everything looks normal until the day it matters.

`infra/check-backups.sh` answers four questions per environment, reading only
file metadata and the gzip header (never the contents — these dumps hold real
personal data):

1. is there a dump at all;
2. is the newest one younger than `MAX_AGE_HOURS` (36 by default — the daily
   cron plus deploy hooks make anything older a signal, not a fluctuation);
3. is it at least `MIN_BYTES` and a valid gzip stream (a truncated dump
   restores nothing while looking like a backup);
4. does the set cover at least `MIN_HISTORY_DAYS` distinct days — one fresh
   dump is not a history, and the retention window is what makes "restore to
   before the bad merge" possible.

It runs **daily at 06:20 UTC** on the self-hosted runner. The issue asked for
monthly; monthly means up to thirty days of believing you have backups when you
do not, and the check costs seconds. On failure an email goes to
`ALERT_EMAIL_TO` from a *GitHub-hosted* job — an alert that needs the failing
server to be healthy is an alert that may never send.

```bash
# By hand, on the server:
./infra/check-backups.sh --env prod --env preview
```

### When the check fails

| Report says | What it means | First move |
|---|---|---|
| `no dump found` | backups never ran here, or the directory moved | check `crontab -l` and `BACKUP_DIR` |
| `stale: Nh old` | the cron or the deploy hook stopped | `tail /var/log/internship-backup.log` |
| `too small` / `not a valid gzip stream` | the dump is being truncated — disk full, or mysqldump dying mid-stream | `df -h`, then run `infra/backup-db.sh` by hand and read the error |
| `history covers only N day(s)` | rotation is deleting faster than it writes, or the box was down | check `KEEP_DAYS` and the log for gaps |

Until it is fixed, assume there is **no usable backup** and do not merge a
schema change.

## The drill

`infra/restore-drill.sh` performs the restore above against a throwaway
database and prints the two numbers. It is the same procedure, executed rather
than described, so the numbers below are measurements and not estimates.

```bash
set -a; . /etc/internship-crm/preview.env; set +a
./infra/restore-drill.sh --env preview --target internship_restore_test
```

Three guards, none optional: the target name must contain `restore` **and**
must differ from the database in `DATABASE_URL`, and the scratch database is
dropped when the drill finishes (a restored dump is a second copy of real
personal data sitting on disk — pass `--keep` only if you are going to inspect
it, and drop it yourself afterwards).

It verifies **row counts** in the tables that carry the product's value —
`User`, `MentorshipRelation`, `InteractionLog`, `StatusChange`, `Evaluation` —
and never prints a row. "The app boots" is not the bar; the accumulated history
coming back is.

It also runs **monthly**, on the 1st, from the same workflow, and on demand via
*Run workflow* → *Also run the restore drill*.

## Drill log

The point of a drill is to measure two numbers and keep them honest:

- **RPO** — how much data a restore would lose (age of the newest usable dump).
- **RTO** — how long the restore actually takes, end to end.

| Date | Environment | Dump used | RPO | RTO | Notes |
|---|---|---|---|---|---|
| 2026-08-24 | dev container (77 tables, 25 users) | `prod-20260824T175256Z.sql.gz` (76 KB) | 0 min | **1 s** | Script validation only — a development database, not preview. Proves the procedure and the guards run end to end; says nothing about how long production takes. |
| _pending_ | preview | | | | run `backup-verify.yml` with *Also run the restore drill* — this is the row that produces quotable numbers |

Run the drill against **preview or a scratch database**, never prod. Fill the
row in with measured values; an estimate here is worse than an empty row,
because it will be believed. RTO scales with dump size, so the dev-container
row above is a lower bound and nothing more.
