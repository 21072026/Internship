#!/usr/bin/env bash
#
# Tests for infra/check-backups-offsite.sh (#2058). The script only ever runs
# against a real bucket on a hosted runner, so its verdicts are pinned here
# from fixture snapshot lists — most importantly that a failure to list reads
# as red, never as "no snapshots yet, fine".
#
# USAGE
#   bash infra/test/check-backups-offsite.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$SCRIPT_DIR/../check-backups-offsite.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
ok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }

NOW=$(date -u -d '2026-10-29T12:00:00Z' +%s)

run() { # $1 = fixture json, rest = env; echoes exit code
  printf '%s' "$1" > "$TMP/s.json"
  env SNAPSHOTS_JSON="$TMP/s.json" NOW_EPOCH="$NOW" "${@:2}" bash "$CHECK" > "$TMP/out.txt" 2>&1
  echo $?
}
expect() { # name, expected exit, json, [env…]
  local got; got=$(run "$3" "${@:4}")
  if [ "$got" = "$2" ]; then ok "$1"; else bad "$1 (exit $got): $(cat "$TMP/out.txt")"; fi
}

snap() { printf '{"time":"%s","host":"internship-crm","tags":["dumps"]}' "$1"; }
HEALTHY="[$(snap 2026-10-27T03:16:01.123456789+00:00),$(snap 2026-10-28T03:15:59.5Z),$(snap 2026-10-29T03:15:30Z)]"

expect 'three days, newest 9h old → healthy'            0 "$HEALTHY"
expect 'empty repository → red'                         1 '[]'
expect 'null (restic on an empty repo) → red'           1 'null'
expect 'garbage instead of JSON → red'                  1 'Fatal: wrong password'
expect 'newest 40h old → red'                           1 "[$(snap 2026-10-26T03:00:00Z),$(snap 2026-10-27T03:00:00Z),$(snap 2026-10-27T20:00:00Z)]"
expect 'one fresh day only → red (no history)'          1 "[$(snap 2026-10-29T03:00:00Z),$(snap 2026-10-29T09:00:00Z)]"
expect 'MIN_HISTORY_DAYS=1 accepts a single fresh day'  0 "[$(snap 2026-10-29T03:00:00Z)]" MIN_HISTORY_DAYS=1
expect 'a non-UTC zone is normalised, not misread'      0 "[$(snap 2026-10-27T05:00:00+02:00),$(snap 2026-10-28T05:00:00+02:00),$(snap 2026-10-29T05:00:00+02:00)]"

# Without the seam and without restic, the script must fail, not pass.
got=$(env -i PATH=/usr/bin:/bin bash -c "PATH=/nonexistent:\$PATH; command -v restic >/dev/null && echo skip || bash '$CHECK' >/dev/null 2>&1; echo \$?" | tail -1)
if [ "$got" = 1 ] || [ "$got" = skip ]; then ok 'restic missing → red'; else bad "restic missing → exit $got"; fi

echo; echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
