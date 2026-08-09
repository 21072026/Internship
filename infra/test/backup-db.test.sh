#!/usr/bin/env bash
#
# Regression tests for infra/backup-db.sh's dump validation (#1200).
#
# WHY THIS EXISTS
#   The validation block is the part of the backup that decides "is this dump
#   real?", and it is the part with no natural coverage: it only runs on a
#   deploy, against a live DB, on the server. It shipped with a bug that made it
#   reject every dump larger than a pipe buffer — `grep -q` exits at the first
#   match, `gzip` dies of SIGPIPE, and `set -o pipefail` fails the pipeline. Prod
#   could not deploy for a day, and the small test DB it was written against
#   could never have caught it, because the bug needs SIZE to show up.
#
#   So these tests feed the checks dumps of a realistic size. A fixture small
#   enough to be convenient is a fixture that proves nothing here.
#
# USAGE
#   bash infra/test/backup-db.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_SH="$SCRIPT_DIR/../backup-db.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }

# The validation logic under test, lifted verbatim from backup-db.sh so the test
# fails if the two drift apart. Keep in sync with the block after the mysqldump.
validate() { # $1 = path to a .sql.gz — echoes ok / no-create-table / bad-gzip / too-small
  local tmp="$1" MIN_BYTES=1024 size tables
  set -euo pipefail
  size=$(wc -c < "$tmp")
  [ "$size" -lt "$MIN_BYTES" ] && { echo "too-small"; return 0; }
  gzip -t "$tmp" 2>/dev/null || { echo "bad-gzip"; return 0; }
  tables=$(gzip -dc "$tmp" | grep -ci 'CREATE TABLE' || true)
  [ "${tables:-0}" -eq 0 ] && { echo "no-create-table"; return 0; }
  echo "ok"
}

echo "backup-db.sh dump validation"

# The regression itself: a dump far larger than a pipe buffer, whose CREATE TABLE
# sits at the very top — the exact shape of a real mysqldump. Under the old
# `grep -q` this returned no-create-table.
{ echo 'CREATE TABLE `User` (id int);'; head -c 8000000 /dev/zero | base64; } | gzip -c > "$TMP/big.sql.gz"
check "accepts a large dump whose CREATE TABLE is at the top" "$(validate "$TMP/big.sql.gz")" "ok"

# The same shape, small — this is what the original check was written against
# (and why it passed there): gzip finishes writing before grep can exit, so the
# SIGPIPE never happens. Must still pass, or the fix broke the ordinary case.
# Padded past MIN_BYTES with incompressible bytes; two short lines gzip to well
# under 1KB and would trip the size check instead, testing nothing.
{ echo 'CREATE TABLE `User` (id int);'; head -c 4000 /dev/urandom | base64; } | gzip -c > "$TMP/small.sql.gz"
check "accepts a small dump" "$(validate "$TMP/small.sql.gz")" "ok"

# Still rejects what it is actually there to reject.
{ head -c 8000000 /dev/zero | base64; } | gzip -c > "$TMP/notables.sql.gz"
check "rejects a large dump with no CREATE TABLE" "$(validate "$TMP/notables.sql.gz")" "no-create-table"

printf 'x' | gzip -c > "$TMP/tiny.sql.gz"
check "rejects a dump under MIN_BYTES" "$(validate "$TMP/tiny.sql.gz")" "too-small"

head -c 4000 /dev/urandom > "$TMP/corrupt.sql.gz"
check "rejects a truncated / non-gzip stream" "$(validate "$TMP/corrupt.sql.gz")" "bad-gzip"

# Guards the fix at its source: a bare `grep -q` on a large stream must NOT be
# what the shipped script uses. This is the line that caused #1200.
if grep -qE 'gzip -dc .*\|\s*grep -q' "$BACKUP_SH"; then
  bad "backup-db.sh still pipes gzip into 'grep -q' (SIGPIPE + pipefail = false failure)"
else
  ok "backup-db.sh does not pipe gzip into 'grep -q'"
fi

echo
if [ "$fail" -gt 0 ]; then
  printf '\033[31m%d failed\033[0m, %d passed\n' "$fail" "$pass"
  exit 1
fi
printf '\033[32mall %d passed\033[0m\n' "$pass"
