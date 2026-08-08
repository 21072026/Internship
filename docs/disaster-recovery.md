# Disaster recovery — restoring the database

> Status: **runbook**. The backup half is automated (`infra/backup-db.sh`, wired
> into every prod/preview deploy plus a daily cron — see
> [`infra/README.md`](../infra/README.md#5-database-backups--the-destructive-schema-gate)).
> The restore half is this document. Issue: #1183 · Epic: #1179.

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

Times below are **placeholders until the first drill fills them in** — see
"Drill log". Do not quote them to anyone before then.

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

## Drill log

The point of a drill is to measure two numbers and keep them honest:

- **RPO** — how much data a restore would lose (age of the newest usable dump).
- **RTO** — how long the restore actually takes, end to end.

| Date | Environment | Dump used | RPO | RTO | Notes |
|---|---|---|---|---|---|
| _pending_ | preview | | | | first drill not yet run — do this before quoting any recovery time |

Run the drill against **preview or a scratch database**, never prod. Fill the
row in with measured values; an estimate here is worse than an empty row,
because it will be believed.
