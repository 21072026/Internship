#!/usr/bin/env bash
#
# Tests for restore-drill.sh --source offsite (#2058): the network fetch and the
# decryption key make this the riskier path, so the guards must run BEFORE
# anything is fetched. A fake `restic` and `mysql` on PATH record whether they
# were called; no database or bucket is involved.
#
# USAGE
#   bash infra/test/restore-drill-offsite.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRILL="$SCRIPT_DIR/../restore-drill.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
ok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }

mkdir -p "$TMP/bin"
for tool in restic mysql; do
  printf '#!/bin/sh\necho "%s $*" >> "%s/calls"\nexit 0\n' "$tool" "$TMP" > "$TMP/bin/$tool"
  chmod +x "$TMP/bin/$tool"
done
printf 'RESTIC_REPOSITORY=s3:https://example.test/bucket\nRESTIC_PASSWORD=x\n' > "$TMP/offsite.env"

drill() { # args… ; echoes exit code
  rm -f "$TMP/calls"
  PATH="$TMP/bin:$PATH" OFFSITE_ENV="$TMP/offsite.env" \
    DATABASE_URL='mysql://u:p@127.0.0.1:3306/internship_live' \
    bash "$DRILL" "$@" > "$TMP/out.txt" 2>&1
  echo $?
}

got=$(drill --source offsite --target internship_live)
if [ "$got" = 1 ] && [ ! -e "$TMP/calls" ]; then ok 'a non-scratch target is refused before restic runs'; else bad "non-scratch target: exit $got, calls: $(cat "$TMP/calls" 2>/dev/null)"; fi

DATABASE_URL_SAME='mysql://u:p@127.0.0.1:3306/internship_restore_x'
rm -f "$TMP/calls"
PATH="$TMP/bin:$PATH" OFFSITE_ENV="$TMP/offsite.env" DATABASE_URL="$DATABASE_URL_SAME" \
  bash "$DRILL" --source offsite --target internship_restore_x > "$TMP/out.txt" 2>&1
code=$?
if [ "$code" = 1 ] && [ ! -e "$TMP/calls" ]; then ok 'the live database name is refused before restic runs'; else bad "live-name target: exit $code"; fi

got=$(drill --source somewhere --target internship_restore_test)
if [ "$got" = 2 ] && [ ! -e "$TMP/calls" ]; then ok 'an unknown --source is refused'; else bad "unknown source: exit $got"; fi

# drill() pins OFFSITE_ENV, so the missing-file case calls the script directly.
rm -f "$TMP/calls"
PATH="$TMP/bin:$PATH" OFFSITE_ENV="$TMP/missing.env" DATABASE_URL='mysql://u:p@127.0.0.1:3306/internship_live' \
  bash "$DRILL" --source offsite --target internship_restore_test > "$TMP/out.txt" 2>&1
code=$?
if [ "$code" = 1 ] && ! grep -q '^restic' "$TMP/calls" 2>/dev/null; then ok 'missing credentials file fails before any fetch'; else bad "missing env: exit $code"; fi

# A guarded run does call restic restore with the env's dump pattern, and the
# fetched directory is gone afterwards (the fake restic writes nothing, so the
# drill then fails on "no dump" — which is fine: we are testing the fetch).
rm -f "$TMP/calls"
PATH="$TMP/bin:$PATH" OFFSITE_ENV="$TMP/offsite.env" DATABASE_URL='mysql://u:p@127.0.0.1:3306/internship_live' \
  bash "$DRILL" --source offsite --env preview --target internship_restore_test > "$TMP/out.txt" 2>&1
if grep -q '^restic restore latest .*--include /var/backups/internship-crm/preview-\*\.sql\.gz' "$TMP/calls" \
   && ! ls -d /var/tmp/restore-drill-offsite.* >/dev/null 2>&1; then
  ok 'a guarded run fetches the env pattern and removes its scratch directory'
else
  bad "fetch call / cleanup: $(cat "$TMP/calls" 2>/dev/null) | $(ls -d /var/tmp/restore-drill-offsite.* 2>/dev/null)"
fi

echo; echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
