#!/usr/bin/env bash
#
# Restore drill (#1183, epic #1179).
#
# WHY THIS EXISTS
#   A backup nobody has restored is a file, not a backup. This script performs
#   the restore half of docs/disaster-recovery.md against a THROWAWAY database
#   and measures the two numbers that matter:
#
#     RPO — how much data a restore would lose: the age of the dump used.
#     RTO — how long the restore actually takes, end to end.
#
#   Those numbers belong in the runbook as measurements, not estimates, and
#   they only stay true if the drill is repeatable. Hence a script, not a
#   paragraph of instructions.
#
# WHAT IT DOES
#   newest <env> dump → create scratch DB → load it → count rows in the tables
#   that carry the product's value → drop the scratch DB (unless --keep).
#
# SAFETY — this script writes to a database. Three guards, none optional:
#   · the target name must contain "restore" AND must not be the name in
#     DATABASE_URL, so a fat-fingered value cannot land on prod or preview;
#   · it never runs `prisma db push` against the scratch DB (that is a separate,
#     deliberate step in the real procedure);
#   · it drops the scratch DB when it is done, because a restored dump is a
#     second copy of real personal data sitting on disk.
#
# USAGE
#   DATABASE_URL=mysql://user:pass@host:3306/db ./infra/restore-drill.sh [--env prod] [--target internship_restore_test] [--keep]
#
#   DATABASE_URL is used ONLY for the server address and credentials; the drill
#   never reads from or writes to the database named in it.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/internship-crm}"
ENV_NAME="prod"
TARGET_DB="${TARGET_DB:-internship_restore_test}"
KEEP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_NAME="${2:?--env needs a value}"; shift 2 ;;
    --target) TARGET_DB="${2:?--target needs a value}"; shift 2 ;;
    --dir) BACKUP_DIR="${2:?--dir needs a value}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }

: "${DATABASE_URL:?DATABASE_URL is required (for the server address and credentials only)}"

# Same outside-in parse as backup-db.sh — the password may contain @ : / and $.
url="${DATABASE_URL#mysql://}"; url="${url%%\?*}"
creds="${url%@*}"; hostpart="${url##*@}"
db_user="${creds%%:*}"; db_pass="${creds#*:}"
[ "$db_pass" = "$creds" ] && db_pass=""
live_db="${hostpart#*/}"; hostport="${hostpart%%/*}"
db_host="${hostport%%:*}"; db_port="${hostport#*:}"
[ "$db_port" = "$hostport" ] && db_port=3306
decode() { printf '%b' "${1//%/\\x}"; }
db_pass="$(decode "$db_pass")"; db_user="$(decode "$db_user")"

# ── Guards ─────────────────────────────────────────────────────────────────
case "$TARGET_DB" in
  *restore*) : ;;
  *) echo "REFUSED: --target must contain 'restore' (got '$TARGET_DB'). This script only writes to a throwaway database." >&2; exit 1 ;;
esac
if [ "$TARGET_DB" = "$live_db" ]; then
  echo "REFUSED: --target is the database in DATABASE_URL ('$live_db'). A drill never restores onto a live database." >&2
  exit 1
fi

command -v mysql >/dev/null || { echo "ERROR: mysql client not found on PATH" >&2; exit 1; }

dump="$(ls -1 "$BACKUP_DIR/${ENV_NAME}-"*.sql.gz 2>/dev/null | sort | tail -1 || true)"
[ -n "$dump" ] || { echo "ERROR: no ${ENV_NAME} dump in ${BACKUP_DIR}" >&2; exit 1; }

stamp="${dump##*/}"; stamp="${stamp#${ENV_NAME}-}"; stamp="${stamp%.sql.gz}"
taken_epoch=""
if [[ "$stamp" =~ ^([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z$ ]]; then
  taken_epoch=$(date -u -d "${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]} ${BASH_REMATCH[4]}:${BASH_REMATCH[5]}:${BASH_REMATCH[6]}" +%s 2>/dev/null || true)
fi
[ -n "$taken_epoch" ] || taken_epoch=$(stat -c %Y "$dump")
rpo_min=$(( ( $(date -u +%s) - taken_epoch ) / 60 ))

run_sql() { MYSQL_PWD="$db_pass" mysql -h "$db_host" -P "$db_port" -u "$db_user" --batch --skip-column-names "$@"; }

cleanup() {
  if [ "$KEEP" -eq 0 ]; then
    log "Dropping scratch database ${TARGET_DB} (a restored dump is a second copy of real personal data)"
    run_sql -e "DROP DATABASE IF EXISTS \`${TARGET_DB}\`;" || true
  else
    echo "NOTE: ${TARGET_DB} kept (--keep). Drop it yourself — it holds real personal data."
  fi
}
trap cleanup EXIT

log "Dump: ${dump##*/} (taken ${rpo_min} minutes ago)"
log "Restoring into scratch database ${TARGET_DB} on ${db_host}:${db_port}"

start=$(date -u +%s)
run_sql -e "DROP DATABASE IF EXISTS \`${TARGET_DB}\`; CREATE DATABASE \`${TARGET_DB}\` CHARACTER SET utf8mb4;"
gzip -dc "$dump" | MYSQL_PWD="$db_pass" mysql -h "$db_host" -P "$db_port" -u "$db_user" "$TARGET_DB"
rto_s=$(( $(date -u +%s) - start ))

# ── Verify. Row counts, never row CONTENTS: the point is that the history
#    survived, and printing it would put personal data in a CI log. ──────────
log "Verifying the restored copy"
tables=$(run_sql -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${TARGET_DB}';")
echo "tables: ${tables}"
[ "${tables:-0}" -gt 0 ] || { echo "ERROR: restored database has no tables" >&2; exit 1; }

# The product's differentiator is the accumulated history, so those are the
# tables a restore has to bring back — "the app boots" is not the bar.
empty_critical=0
for t in User MentorshipRelation InteractionLog StatusChange Evaluation; do
  exists=$(run_sql -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${TARGET_DB}' AND table_name='${t}';")
  if [ "${exists:-0}" -eq 0 ]; then
    echo "MISSING table ${t}"
    empty_critical=$((empty_critical + 1))
    continue
  fi
  n=$(run_sql -e "SELECT COUNT(*) FROM \`${TARGET_DB}\`.\`${t}\`;")
  echo "${t}: ${n} rows"
done
[ "$empty_critical" -eq 0 ] || { echo "ERROR: ${empty_critical} critical table(s) missing from the dump" >&2; exit 1; }

log "Drill result"
printf 'RPO (age of dump used): %s minutes (%s hours)\n' "$rpo_min" "$((rpo_min / 60))"
printf 'RTO (restore duration): %s seconds\n' "$rto_s"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Restore drill — ${ENV_NAME}"
    echo ""
    echo "| | |"
    echo "|---|---|"
    echo "| Dump | \`${dump##*/}\` |"
    echo "| RPO (dump age) | ${rpo_min} min |"
    echo "| RTO (restore) | ${rto_s} s |"
    echo "| Tables restored | ${tables} |"
    echo ""
    echo "Record these numbers in \`docs/disaster-recovery.md\` → Drill log."
  } >> "$GITHUB_STEP_SUMMARY"
fi
