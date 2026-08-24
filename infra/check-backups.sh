#!/usr/bin/env bash
#
# Backup freshness + integrity check (#1183, epic #1179).
#
# WHY THIS EXISTS
#   infra/backup-db.sh validates the dump it just wrote. Nothing until now
#   validated that it is still RUNNING. The failure this catches is the quiet
#   one: the cron entry was dropped during a server rebuild, the deploy hook
#   started failing before the backup step, the disk filled — and the newest
#   dump is three weeks old, which nobody notices until the day it is needed.
#
# WHAT IT CHECKS, per environment
#   1. a dump exists at all;
#   2. the newest one is younger than MAX_AGE_HOURS;
#   3. it is at least MIN_BYTES and a valid gzip stream (a truncated dump
#      restores nothing while looking like a backup);
#   4. the set covers at least MIN_HISTORY_DAYS distinct days — one fresh dump
#      is not a history, and the retention window is what makes "restore to
#      before the bad merge" possible.
#
#   It reads only metadata and the gzip header. It never decompresses a dump to
#   disk and never prints its contents: these files hold real personal data.
#
# USAGE
#   ./infra/check-backups.sh [--env prod] [--env preview]
#     BACKUP_DIR        default /var/backups/internship-crm
#     MAX_AGE_HOURS     default 36  (daily cron + deploy hooks → 36h is late)
#     MIN_BYTES         default 1024
#     MIN_HISTORY_DAYS  default 3   (KEEP_DAYS is 7; 3 distinct days means the
#                                    rotation is alive without failing the check
#                                    on a server that was down for a weekend)
#
# Exit 0 = every checked environment is healthy. Exit 1 = at least one is not,
# and the reason is on stdout (safe to email — no data, no secrets).
set -uo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/internship-crm}"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-36}"
MIN_BYTES="${MIN_BYTES:-1024}"
MIN_HISTORY_DAYS="${MIN_HISTORY_DAYS:-3}"
ENVS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENVS+=("${2:?--env needs a value}"); shift 2 ;;
    --dir) BACKUP_DIR="${2:?--dir needs a value}"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done
[ "${#ENVS[@]}" -gt 0 ] || ENVS=(prod preview)

failures=0
report=""

emit() { report+="$1"$'\n'; echo "$1"; }

for env_name in "${ENVS[@]}"; do
  newest=""
  # Sort by name, not mtime: the stamp in the filename is when the dump was
  # TAKEN, and a file copied or touched later would otherwise look fresh.
  newest="$(ls -1 "$BACKUP_DIR/${env_name}-"*.sql.gz 2>/dev/null | sort | tail -1 || true)"

  if [ -z "$newest" ]; then
    emit "FAIL  ${env_name}: no dump found in ${BACKUP_DIR}"
    failures=$((failures + 1))
    continue
  fi

  size=$(wc -c < "$newest")
  # Age from the STAMP in the filename (<env>-YYYYmmddTHHMMSSZ.sql.gz), falling
  # back to mtime for a file that predates that naming.
  stamp="${newest##*/}"; stamp="${stamp#${env_name}-}"; stamp="${stamp%.sql.gz}"
  taken_epoch=""
  if [[ "$stamp" =~ ^([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z$ ]]; then
    taken_epoch=$(date -u -d "${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]} ${BASH_REMATCH[4]}:${BASH_REMATCH[5]}:${BASH_REMATCH[6]}" +%s 2>/dev/null || true)
  fi
  [ -n "$taken_epoch" ] || taken_epoch=$(stat -c %Y "$newest")
  age_h=$(( ( $(date -u +%s) - taken_epoch ) / 3600 ))

  # Distinct days covered — the retention window, not the file count (a deploy
  # storm can write six dumps in one afternoon).
  history=$(ls -1 "$BACKUP_DIR/${env_name}-"*.sql.gz 2>/dev/null \
    | sed -E "s#.*/${env_name}-([0-9]{8})T.*#\1#" | sort -u | wc -l)

  problems=()
  [ "$age_h" -le "$MAX_AGE_HOURS" ] || problems+=("stale: ${age_h}h old (limit ${MAX_AGE_HOURS}h)")
  [ "$size" -ge "$MIN_BYTES" ] || problems+=("too small: ${size}B (min ${MIN_BYTES}B)")
  gzip -t "$newest" 2>/dev/null || problems+=("not a valid gzip stream (truncated?)")
  [ "$history" -ge "$MIN_HISTORY_DAYS" ] || problems+=("history covers only ${history} day(s) (min ${MIN_HISTORY_DAYS})")

  if [ "${#problems[@]}" -eq 0 ]; then
    emit "OK    ${env_name}: ${newest##*/} — ${age_h}h old, ${size}B, ${history} day(s) retained"
  else
    # Join with "; " — IFS only contributes its FIRST character, so build it.
    joined=""
    for problem in "${problems[@]}"; do
      [ -z "$joined" ] && joined="$problem" || joined="${joined}; ${problem}"
    done
    emit "FAIL  ${env_name}: ${newest##*/} — ${joined}"
    failures=$((failures + 1))
  fi
done

# Machine-readable trail for the workflow summary. Deliberately just the
# verdict — the detail is above, and none of it is sensitive.
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Backup verification"
    echo '```'
    printf '%s' "$report"
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
fi

if [ "$failures" -gt 0 ]; then
  echo ""
  echo "${failures} environment(s) failed the backup check — see docs/disaster-recovery.md"
  exit 1
fi
echo ""
echo "All checked environments have a fresh, non-empty, well-formed backup."
