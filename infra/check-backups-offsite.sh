#!/usr/bin/env bash
#
# Off-site backup freshness check (#2058) — the restic/R2 copy, judged from
# OUTSIDE the box that writes it.
#
# WHY A SEPARATE SCRIPT, RUN ELSEWHERE
#   infra/check-backups.sh reads the local dumps and runs on the self-hosted
#   runner, which lives on the production host. That is the right witness for
#   "is the backup cron alive", and the wrong one for "does a copy survive this
#   box": if the host is gone, so is the watcher. This script needs nothing but
#   the repository credentials, so backup-verify.yml runs it on a GitHub-hosted
#   runner (`verify-offsite`), and it alerts through the same issue + email.
#
# WHAT IT CHECKS (snapshots written by infra/server/backup-offsite.sh, host
# `internship-crm`, tag `dumps`)
#   1. at least one snapshot exists;
#   2. the newest is younger than MAX_AGE_HOURS (daily cron → 36h is late);
#   3. the snapshots cover at least MIN_HISTORY_DAYS distinct UTC days — the
#      retention (`forget --keep-daily 14 …`) is what makes "restore to before
#      the bad merge" possible, and one fresh snapshot is not a history.
#   It reads snapshot METADATA only (`restic snapshots --json`): no dump is
#   downloaded or decrypted, and nothing it prints is personal data.
#
# USAGE
#   RESTIC_REPOSITORY=… RESTIC_PASSWORD=… AWS_ACCESS_KEY_ID=… \
#   AWS_SECRET_ACCESS_KEY=… ./infra/check-backups-offsite.sh
#     MAX_AGE_HOURS     default 36
#     MIN_HISTORY_DAYS  default 3
#     SNAPSHOTS_JSON    test seam: read this file instead of calling restic
#     NOW_EPOCH         test seam: "now" in seconds since the epoch
#
# Exit 0 = healthy. Exit 1 = not, reason on stdout (safe to email).
set -uo pipefail

MAX_AGE_HOURS="${MAX_AGE_HOURS:-36}"
MIN_HISTORY_DAYS="${MIN_HISTORY_DAYS:-3}"
NOW_EPOCH="${NOW_EPOCH:-$(date -u +%s)}"

fail() { echo "❌ off-site: $1"; exit 1; }

if [ -n "${SNAPSHOTS_JSON:-}" ]; then
  json="$(cat "$SNAPSHOTS_JSON")" || fail "cannot read $SNAPSHOTS_JSON"
else
  command -v restic >/dev/null || fail "restic is not installed"
  : "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is not set}"
  # Fail closed: an unreachable bucket or a wrong password is a red check, never
  # an empty list read as "no snapshots yet". --no-lock: the checker's R2 token
  # is read-only on purpose, and restic would otherwise try to write a lock file.
  json="$(restic snapshots --no-lock --host internship-crm --tag dumps --json 2>/tmp/restic-err.txt)" \
    || fail "cannot list snapshots: $(head -c 300 /tmp/restic-err.txt | tr '\n' ' ')"
fi

# Snapshot times are RFC 3339 with a zone; python normalises them to epochs.
read -r count newest days < <(printf '%s' "$json" | python3 -c '
import sys, json
from datetime import datetime, timezone
try:
    snaps = json.load(sys.stdin) or []
except ValueError:
    print("bad 0 0"); sys.exit(0)
epochs = []
for s in snaps:
    t = s.get("time", "")
    # restic writes nanoseconds; datetime takes microseconds.
    if "." in t:
        head, rest = t.split(".", 1)
        frac = "".join(c for c in rest if c.isdigit())[:6]
        zone = rest[len("".join(c for c in rest if c.isdigit())):]
        t = f"{head}.{frac}{zone}"
    epochs.append(datetime.fromisoformat(t.replace("Z", "+00:00")).astimezone(timezone.utc))
days = {e.date() for e in epochs}
print(len(epochs), int(max(epochs).timestamp()) if epochs else 0, len(days))
')

[ "$count" = bad ] && fail "restic returned something that is not a snapshot list"
[ "$count" -gt 0 ] || fail "no snapshots in the repository"

age_h=$(( (NOW_EPOCH - newest) / 3600 ))
[ "$age_h" -le "$MAX_AGE_HOURS" ] || fail "newest snapshot is ${age_h}h old (limit ${MAX_AGE_HOURS}h)"
[ "$days" -ge "$MIN_HISTORY_DAYS" ] || fail "snapshots cover ${days} distinct day(s) (need ${MIN_HISTORY_DAYS})"

echo "✅ off-site: ${count} snapshot(s) over ${days} day(s), newest ${age_h}h old"
