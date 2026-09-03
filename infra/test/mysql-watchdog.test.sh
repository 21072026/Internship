#!/usr/bin/env bash
#
# Regression tests for infra/mysql-watchdog.sh.
#
# WHY THIS EXISTS
#   The watchdog only ever runs on the production box, at the moment the
#   database is already down — the worst possible time to discover that its
#   liveness probe is wrong. Two mistakes here are worse than having no
#   watchdog at all:
#     · treating a HEALTHY server as dead (a server that answers "Access
#       denied" to an unauthenticated ping is alive) would restart the database
#       every minute, forever;
#     · treating a DEAD server as healthy would silently do nothing, which is
#       the exact failure the watchdog exists to end.
#   Both are pure shell logic, so both are testable without a database: the
#   tests stub `mysqladmin` and `systemctl` on PATH and assert what the script
#   decides and which commands it issues.
#
# USAGE
#   bash infra/test/mysql-watchdog.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WATCHDOG="$SCRIPT_DIR/../mysql-watchdog.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }
contains() { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1 (missing '$3' in: $2)" ;; esac; }
lacks() { case "$2" in *"$3"*) bad "$1 (unexpectedly found '$3')" ;; *) ok "$1" ;; esac; }

# ── stub harness ──────────────────────────────────────────────────────────────
# PING_MODE drives the fake mysqladmin; every systemctl call is appended to
# $BIN/systemctl.calls so a test can assert that the database was (or was not)
# restarted. `systemctl start` flips PING_MODE to alive when START_RECOVERS=1,
# which is how a real recovery looks from the script's point of view.
BIN="$TMP/bin"
mkdir -p "$BIN"
# The script only trusts systemctl when systemd is actually PID 1 (it probes
# $SYSTEMD_RUN_DIR). Fake that directory so the systemd path is the one under
# test; the SysV fallback gets its own case at the bottom, with it removed.
FAKE_SYSTEMD_RUN="$TMP/run-systemd"
mkdir -p "$FAKE_SYSTEMD_RUN"

# The stub is picky in exactly the way the real MariaDB client is: it accepts
# `--no-defaults` ONLY as the first argument and otherwise exits 2 with
# `unknown option`. The real client's behaviour here is not a detail — passing
# that flag second made every probe report a healthy server as down, which
# would have restarted the production database once a minute.
cat > "$BIN/mysqladmin" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$STUB_STATE/mysqladmin.calls"
for i in $(seq 2 $#); do
  if [ "${!i}" = "--no-defaults" ]; then
    echo "mysqladmin: unknown option '--no-defaults'"; exit 2
  fi
done
mode="$(cat "$STUB_STATE/ping_mode" 2>/dev/null || echo alive)"
case "$mode" in
  alive)  echo "mysqld is alive"; exit 0 ;;
  denied) echo "mysqladmin: connect to server at 'localhost' failed"
          echo "error: 'Access denied for user 'root'@'localhost' (using password: NO)'"; exit 1 ;;
  *)      echo "mysqladmin: connect to server at '127.0.0.1' failed"
          echo "error: 'Can't connect to MySQL server on '127.0.0.1:3306' (111)'"; exit 1 ;;
esac
EOF

cat > "$BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$STUB_STATE/systemctl.calls"
case "$1" in
  cat) [ "$2" = "mysql.service" ] && exit 0 || exit 1 ;;
  start)
    [ "${START_RECOVERS:-1}" = "1" ] && echo alive > "$STUB_STATE/ping_mode"
    exit 0 ;;
  is-active) echo active ;;
  is-enabled) echo enabled ;;
esac
exit 0
EOF

# The script escalates privileges with `sudo -n <cmd>` whenever it is not root.
# The REAL sudo resets PATH (secure_path), so the stubs above would be bypassed
# and the command would hit the host's actual init system — on a CI runner that
# means these tests would start and stop the machine's real MySQL. Shadowing
# sudo keeps every privileged call inside this PATH.
cat > "$BIN/sudo" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = "-n" ] && shift
exec "$@"
EOF

chmod +x "$BIN/mysqladmin" "$BIN/systemctl" "$BIN/sudo"

run_watchdog() { # $1 = ping mode, rest = extra args; sets $out and $rc
  local mode="$1"; shift
  export STUB_STATE="$TMP/state"
  rm -rf "$STUB_STATE"; mkdir -p "$STUB_STATE"
  echo "$mode" > "$STUB_STATE/ping_mode"
  : > "$STUB_STATE/systemctl.calls"
  : > "$STUB_STATE/mysqladmin.calls"
  out="$(PATH="$BIN:$PATH" \
    LOG_FILE="$TMP/watchdog.log" STATE_DIR="$TMP/state-dir" SYSTEMD_DIR="$TMP/systemd" \
    SYSTEMD_RUN_DIR="${SYSTEMD_RUN_DIR_OVERRIDE:-$FAKE_SYSTEMD_RUN}" \
    INITD_DIR="${INITD_DIR_OVERRIDE:-$TMP/empty-initd}" \
    WAIT_SECONDS=2 POLL_SECONDS=1 ATTEMPTS=1 \
    bash "$WATCHDOG" "$@" 2>&1)"
  rc=$?
  calls="$(cat "$STUB_STATE/systemctl.calls" 2>/dev/null)"
  pings="$(cat "$STUB_STATE/mysqladmin.calls" 2>/dev/null)"
}

echo "mysql-watchdog.sh"

# 1. A healthy database is left completely alone — no restart, no noise.
run_watchdog alive
check "healthy database → exit 0" "$rc" "0"
lacks "healthy database is not restarted" "$calls" "start"
check "healthy database logs nothing" "$out" ""

# 1b. The probe must never read a ~/.my.cnf (it needs no credentials), and the
#     flag that guarantees that only works as the FIRST argument.
run_watchdog alive
case "$pings" in
  "--no-defaults "*) ok "probe passes --no-defaults first, where the client accepts it" ;;
  *) bad "probe does not pass --no-defaults first (got: $pings)" ;;
esac

# 2. THE regression that would make the watchdog worse than nothing: an
#    unauthenticated ping answered with "Access denied" is a LIVE server.
run_watchdog denied
check "access-denied ping → exit 0 (server answered)" "$rc" "0"
lacks "access-denied ping does not restart the database" "$calls" "start"

# 3. A dead database is detected and started.
run_watchdog dead
check "dead database → exit 0 after recovery" "$rc" "0"
contains "dead database is started" "$calls" "start mysql.service"
contains "recovery is logged" "$out" "RECOVERED"

# 4. When the start does not help, the run FAILS — that is what turns into an
#    email. Recovering quietly from an unrecoverable state is the failure mode
#    that lets a database stay down all night.
START_RECOVERS=0 run_watchdog dead
check "unrecoverable database → exit 1" "$rc" "1"
contains "unrecoverable database says so" "$out" "needs a human"

# 5. --install writes both the timer and the unit hardening, and the hardening
#    is the part that must contain Restart=always: without it systemd gives up
#    after a handful of OOM kills and the box stays down until a human logs in.
export STUB_STATE="$TMP/state"; mkdir -p "$STUB_STATE"; echo alive > "$STUB_STATE/ping_mode"
PATH="$BIN:$PATH" LOG_FILE="$TMP/watchdog.log" SYSTEMD_DIR="$TMP/systemd" \
  SYSTEMD_RUN_DIR="$FAKE_SYSTEMD_RUN" bash "$WATCHDOG" --install >/dev/null 2>&1
dropin="$TMP/systemd/mysql.service.d/10-internship-oom.conf"
check "--install writes the OOM drop-in" "$([ -f "$dropin" ] && echo yes || echo no)" "yes"
contains "drop-in restarts the database always" "$(cat "$dropin" 2>/dev/null)" "Restart=always"
contains "drop-in removes the start-rate limit" "$(cat "$dropin" 2>/dev/null)" "StartLimitIntervalSec=0"
contains "drop-in de-prioritizes mysqld for the OOM killer" "$(cat "$dropin" 2>/dev/null)" "OOMScoreAdjust=-500"
check "--install writes the timer" \
  "$([ -f "$TMP/systemd/internship-mysql-watchdog.timer" ] && echo yes || echo no)" "yes"
contains "timer runs the check, not something else" \
  "$(cat "$TMP/systemd/internship-mysql-watchdog.service" 2>/dev/null)" "mysql-watchdog.sh --check"

# 6. --uninstall leaves nothing behind (a half-removed watchdog that still
#    holds the Restart=always drop-in is a surprise for the next person).
PATH="$BIN:$PATH" LOG_FILE="$TMP/watchdog.log" SYSTEMD_DIR="$TMP/systemd" \
  SYSTEMD_RUN_DIR="$FAKE_SYSTEMD_RUN" bash "$WATCHDOG" --uninstall >/dev/null 2>&1
check "--uninstall removes the drop-in" "$([ -f "$dropin" ] && echo yes || echo no)" "no"
check "--uninstall removes the timer" \
  "$([ -f "$TMP/systemd/internship-mysql-watchdog.timer" ] && echo yes || echo no)" "no"

# 7. --status never touches the database, whatever it finds.
run_watchdog dead --status
lacks "--status does not restart anything" "$calls" "start"
check "--status reports a dead database as down" "$rc" "1"
contains "--status names the state" "$out" "DOWN"

# 8. No systemd (a container, or an older box): `systemctl` may still be
#    INSTALLED and answer every call with "System has not been booted with
#    systemd" — trusting its presence would leave the database down while the
#    log claims a restart was issued. The script must fall back to the SysV
#    `service` command that `service mysql start` actually drives.
cat > "$BIN/service" <<'EOF'
#!/usr/bin/env bash
echo "service $*" >> "$STUB_STATE/systemctl.calls"
[ "${2:-}" = "start" ] && [ "${START_RECOVERS:-1}" = "1" ] && echo alive > "$STUB_STATE/ping_mode"
exit 0
EOF
chmod +x "$BIN/service"
mkdir -p "$TMP/initd" "$TMP/empty-initd"
: > "$TMP/initd/mysql" && chmod +x "$TMP/initd/mysql"

SYSTEMD_RUN_DIR_OVERRIDE="$TMP/no-systemd" INITD_DIR_OVERRIDE="$TMP/initd" run_watchdog dead
check "no systemd but an init script → recovers via service(8)" "$rc" "0"
contains "uses the SysV command" "$calls" "service mysql start"
lacks "does not issue a systemd start it cannot make" "$calls" "start mysql.service"

# 9. Neither systemd nor an init script: refuse clearly instead of reporting a
#    restart that never happened.
SYSTEMD_RUN_DIR_OVERRIDE="$TMP/no-systemd" INITD_DIR_OVERRIDE="$TMP/empty-initd" run_watchdog dead
check "nothing to restart with → exit 1" "$rc" "1"
contains "says why it cannot restart" "$out" "cannot restart"

# 10. A probe that cannot run is not a probe that says "down": mysqladmin
#     failing on its own arguments must be reported and fall through to the TCP
#     check, never silently restart a database nobody proved was down.
cat > "$BIN/mysqladmin" <<'EOF'
#!/usr/bin/env bash
echo "mysqladmin: unknown option '--some-flag'"
exit 2
EOF
chmod +x "$BIN/mysqladmin"
run_watchdog alive
contains "an unusable mysqladmin is reported, not believed" "$out" "falling back to a TCP connect"

echo
if [ "$fail" -gt 0 ]; then
  printf '\033[31m%d failed\033[0m, %d passed\n' "$fail" "$pass"
  exit 1
fi
printf '\033[32mall %d checks passed\033[0m\n' "$pass"
