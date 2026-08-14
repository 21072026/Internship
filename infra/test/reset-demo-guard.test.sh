#!/usr/bin/env bash
#
# Guard tests for prisma/reset-demo.mjs (#966).
#
# WHY THIS EXISTS
#   That script truncates every table in the database it is pointed at. The only
#   thing standing between it and production is the check at the top, and that
#   check runs nowhere except on the server during a scheduled job — exactly the
#   blind spot that let a too-broad schema guard stall prod for six releases
#   (#1230) and a broken backup validator ship (#1200).
#
#   So this asserts the refusal directly, against the real production and
#   preview database names. Every case here must fail BEFORE any connection is
#   attempted, which is why the fixtures point at an unroutable host: if a case
#   ever passes the guard, it hangs or errors on connect instead of quietly
#   wiping something, and the test still fails.
#
# USAGE
#   bash infra/test/reset-demo-guard.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RESET_MJS="$REPO_ROOT/prisma/reset-demo.mjs"

pass=0; fail=0
ok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }

# 192.0.2.0/24 is TEST-NET-1 (RFC 5737): guaranteed not to route anywhere.
HOST='192.0.2.1:3306'

# $1 = label, $2 = DEMO_MODE, $3 = database name (empty for "no DATABASE_URL")
expect_refusal() {
  local label="$1" mode="$2" db="$3" out status
  if [ -z "$db" ]; then
    out=$(cd "$REPO_ROOT" && DEMO_MODE="$mode" DATABASE_URL="" node "$RESET_MJS" 2>&1)
  else
    out=$(cd "$REPO_ROOT" && DEMO_MODE="$mode" DATABASE_URL="mysql://u:p@$HOST/$db" node "$RESET_MJS" 2>&1)
  fi
  status=$?
  if [ "$status" -eq 0 ]; then
    bad "$label — exited 0 (did NOT refuse)"
  elif printf '%s' "$out" | grep -q 'refusing to run'; then
    ok "refuses: $label"
  else
    bad "$label — exited $status but not via the guard: ${out:0:160}"
  fi
}

echo "The guard must refuse these outright:"
expect_refusal 'production database name'      true  internship_crm
expect_refusal 'shared preview database name'  true  internship_crm_preview
expect_refusal 'DEMO_MODE unset'               ''    internship_crm_demo
expect_refusal 'DEMO_MODE=1 (not "true")'      1     internship_crm_demo
expect_refusal 'DEMO_MODE=false'               false internship_crm_demo
expect_refusal 'no DATABASE_URL'               true  ''
expect_refusal 'demo as a prefix, not suffix'  true  demo_internship_crm
expect_refusal '_demo inside the name only'    true  internship_demo_crm

echo
echo "The demo database name must get PAST the guard (and then fail on connect):"
out=$(cd "$REPO_ROOT" && DEMO_MODE=true DATABASE_URL="mysql://u:p@$HOST/internship_crm_demo" node "$RESET_MJS" 2>&1)
if printf '%s' "$out" | grep -q 'refusing to run'; then
  bad 'internship_crm_demo was refused — the guard is too strict to ever reset the demo'
else
  ok 'internship_crm_demo passes the guard'
fi

echo
printf 'Total: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
