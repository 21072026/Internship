#!/usr/bin/env bash
#
# Regression tests for infra/marketing-teardown.sh.
#
# WHY THIS EXISTS
#   The script runs once, as root, on the box that also serves Internship, and
#   every mistake it can make is irreversible. The three that would actually
#   hurt are pure shell logic, so they are testable with stubs:
#     · deleting more than Marketing — an Internship container, or
#       `docker image prune -a` taking every unused image with it (the source
#       repo's own teardown script did exactly that);
#     · dropping the database before the dump is known good;
#     · removing the Plesk subdomain while a mail domain still points at it —
#       the mistake that cost a 7-day fail2ban on crm.ersah.in.
#   Every binary it touches is stubbed on PATH and records its arguments, so
#   each test asserts what the script DID, not what it printed.
#
# USAGE
#   bash infra/test/marketing-teardown.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEARDOWN="$SCRIPT_DIR/../marketing-teardown.sh"
TMP="$(mktemp -d)"
# KEEP_TMP=1 leaves the per-case state dirs (each holds the script's full
# output and every stub's call log) — the only way to see WHY a case failed.
[ -n "${KEEP_TMP:-}" ] && echo "state: $TMP" || trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
ok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }
contains() { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1 (missing '$3')" ;; esac; }
lacks()    { case "$2" in *"$3"*) bad "$1 (unexpectedly found '$3')" ;; *) ok "$1" ;; esac; }
check()    { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }

BIN="$TMP/bin"
mkdir -p "$BIN"

# Every stub logs its argv to $STUB_STATE/<name>.calls. MAIL_HIT and DUMP_BROKEN
# switch the two scenarios that must stop the script.
cat > "$BIN/docker" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$STUB_STATE/docker.calls"
case "$1 $2" in
  "ps -a"|"ps --filter")
    # One Marketing container, one PR environment, and one Internship
    # container that shares the `salevali` filter's blast radius by sitting on
    # the same box. The third must survive.
    if [[ "$*" == *"name=internship-crm"* ]]; then echo "internship-crm-prod Up 3 days"; exit 0; fi
    echo "salevali-crm-marketing"; echo "salevali-crm-marketing-pr7"; echo "internship-crm-prod" ;;
  "images "*) [ "${3:-}" = "-q" ] && { echo sha256:aaa; echo sha256:bbb; } || echo "ghcr.io/21072026/marketing:latest" ;;
esac
exit 0
EOF

cat > "$BIN/mysql" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$STUB_STATE/mysql.calls"
case "$*" in
  *"SHOW DATABASES LIKE"*) echo "salevali_crm_test" ;;
  *"SHOW DATABASES"*) echo "internship_crm"; echo "internship_crm_preview" ;;
  *"information_schema"*) echo "salevali_crm_test	41" ;;
esac
exit 0
EOF

cat > "$BIN/mysqldump" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$STUB_STATE/mysqldump.calls"
# empty: gzip still produces a VALID member, so only the size/content checks
# can catch it. notables: big enough to pass the size floor, but degenerate.
[ "${DUMP_BROKEN:-0}" = "1" ] && exit 0
# Incompressible padding on both paths: the size floor is measured on the
# GZIPPED file (as in backup-db.sh), so a repetitive fake dump would fail the
# size check for the wrong reason and hide whatever the case is really testing.
if [ "${DUMP_NOTABLES:-0}" = "1" ]; then head -c 40000 /dev/urandom | base64; exit 0; fi
echo "-- dump of $*"
for i in $(seq 1 40); do echo "CREATE TABLE t$i (id INT);"; done
head -c 40000 /dev/urandom | base64
EOF

cat > "$BIN/plesk" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$STUB_STATE/plesk.calls"
case "$*" in
  "bin mail --info marketing.ersah.in") exit "${MAIL_HIT:-1}" ;;  # 1 = no mail domain
  "bin subdomain --list") echo "marketing.ersah.in"; echo "marketing-pr7.ersah.in"; echo "crm.ersah.in" ;;
  "bin certificate --info"*) exit 0 ;;
esac
exit 0
EOF

cat > "$BIN/curl" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$STUB_STATE/curl.calls"
exit 0
EOF

# The script uses `sudo -n` whenever it is not root; under test it never is.
cat > "$BIN/sudo" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = "-n" ] && shift
exec "$@"
EOF

chmod +x "$BIN"/*

# Scenario switches, reset after every case so one test cannot leak into the
# next. `run` must NOT be called in a command substitution: it sets STATUS and
# STATE in this shell, which a subshell would throw away.
MAIL_HIT=1; DUMP_BROKEN=0; DUMP_NOTABLES=0; CONFIRM=''
run() { # run <state-dir> [args...] -> $OUT, $STATUS, $STATE
  local state="$TMP/$1"; shift
  rm -rf "$state"; mkdir -p "$state" "$state/backups" "$state/etc" "$state/home/.ssh"
  printf 'SECRET=x\n' > "$state/etc/test.env"
  env -i PATH="$BIN:/usr/bin:/bin" HOME="$state/home" STUB_STATE="$state" \
    BACKUP_DIR="$state/backups" ENV_DIR="$state/etc" ENV_FILE="$state/etc/test.env" \
    MAIL_HIT="$MAIL_HIT" DUMP_BROKEN="$DUMP_BROKEN" DUMP_NOTABLES="$DUMP_NOTABLES" \
    TEARDOWN_CONFIRM="$CONFIRM" \
    bash "$TEARDOWN" "$@" >"$state/out" 2>&1
  STATUS=$?
  STATE="$state"
  OUT="$(cat "$state/out")"
  MAIL_HIT=1; DUMP_BROKEN=0; DUMP_NOTABLES=0; CONFIRM=''
}

echo "infra/marketing-teardown.sh"

# ── 1 · inventory is read-only ───────────────────────────────────────────────
run inv --inventory
check "inventory exits 0" "$STATUS" "0"
contains "inventory reports the mail check" "$OUT" "Mail trap check"
lacks "inventory never drops a database" "$(cat "$STATE/mysql.calls")" "DROP"
lacks "inventory never removes a container" "$(cat "$STATE/docker.calls")" "rm "
[ -f "$STATE/etc/test.env" ] && ok "inventory leaves the env file alone" || bad "inventory deleted the env file"

# ── 2 · --apply refuses without the confirmation phrase ──────────────────────
CONFIRM=""; run noconfirm --apply
[ "$STATUS" -ne 0 ] && ok "--apply without TEARDOWN_CONFIRM fails" || bad "--apply ran unconfirmed"
contains "and says what is missing" "$OUT" "TEARDOWN_CONFIRM"
lacks "and dropped nothing" "$(cat "$STATE/mysql.calls")" "DROP"

# ── 3 · a live mail reference stops it before the subdomains ────────────────
MAIL_HIT=0; CONFIRM=SOK-MARKETING; run mailhit --apply
[ "$STATUS" -ne 0 ] && ok "a mail domain aborts the run" || bad "ran despite a mail domain"
contains "and explains the fix" "$OUT" "MAIL_CLEARED=1"
lacks "no subdomain was removed" "$(cat "$STATE/plesk.calls")" "subdomain --remove"

# ── 4 · a bad dump stops it before the DROP ─────────────────────────────────
DUMP_BROKEN=1; CONFIRM=SOK-MARKETING; run baddump --apply
[ "$STATUS" -ne 0 ] && ok "an empty dump aborts the run" || bad "ran on an empty dump"
lacks "database survives an empty dump" "$(cat "$STATE/mysql.calls")" "DROP DATABASE"

# gzip -t passes on both of these, which is the point: only size and content
# separate a real dump from a mysqldump that wrote nothing useful.
DUMP_NOTABLES=1; CONFIRM=SOK-MARKETING; run notables --apply
[ "$STATUS" -ne 0 ] && ok "a dump with no CREATE TABLE aborts the run" || bad "ran on a degenerate dump"
lacks "database survives a degenerate dump" "$(cat "$STATE/mysql.calls")" "DROP DATABASE"

# ── 5 · the clean path deletes Marketing and only Marketing ─────────────────
CONFIRM=SOK-MARKETING; run clean --apply
check "clean run exits 0" "$STATUS" "0"
DOCKER="$(cat "$STATE/docker.calls")"; MYSQL="$(cat "$STATE/mysql.calls")"; PLESK="$(cat "$STATE/plesk.calls")"
contains "removes the Marketing container" "$DOCKER" "rm salevali-crm-marketing"
contains "removes the PR environment" "$DOCKER" "rm salevali-crm-marketing-pr7"
lacks "never touches the Internship container" "$DOCKER" "internship-crm-prod"
lacks "never prunes images wholesale" "$DOCKER" "prune"
contains "removes Marketing images by id" "$DOCKER" "rmi sha256:aaa"
contains "drops only the Marketing database" "$MYSQL" "DROP DATABASE IF EXISTS salevali_crm_test"
lacks "never drops an Internship database" "$MYSQL" "DROP DATABASE IF EXISTS internship"
contains "drops the container-network grant too" "$MYSQL" "'salevali_test'@'172.17.%'"
contains "removes the Marketing subdomain" "$PLESK" "subdomain --remove marketing -domain ersah.in"
contains "removes the PR subdomain" "$PLESK" "subdomain --remove marketing-pr7 -domain ersah.in"
lacks "never removes crm.ersah.in" "$PLESK" "subdomain --remove crm"
lacks "never removes the shared certificate" "$PLESK" "certificate --remove"
[ -f "$STATE/etc/test.env" ] && bad "env file was not shredded" || ok "shreds the env file"
ls "$STATE/backups"/salevali_crm_test-*.sql.gz >/dev/null 2>&1 && ok "leaves a verified dump behind" || bad "no dump was kept"
ls "$STATE/backups"/*.part >/dev/null 2>&1 && bad "left a .part file behind" || ok "no partial dump left"
contains "verifies Internship at the end" "$OUT" "Internship verified"

# ── 6 · the script text itself must not contain the two forbidden commands ──
# Comments are stripped first: both commands are NAMED in this script's
# comments as the mistakes it exists to avoid, and that documentation must not
# make the guard fail.
SRC="$(grep -v '^[[:space:]]*#' "$TEARDOWN")"
lacks "source never calls 'docker image prune'" "$SRC" "image prune"
lacks "source never calls 'certificate --remove'" "$SRC" "certificate --remove"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
