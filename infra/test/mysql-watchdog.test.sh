#!/usr/bin/env bash
#
# Regression tests for infra/mysql-watchdog.sh.
#
# WHY THIS EXISTS
#   The watchdog only ever matters on the production box, at the moment the
#   database is already down — the worst possible time to discover that its
#   liveness probe is wrong. The mistakes worth pinning:
#     · treating a HEALTHY server as dead (a server that answers "Access
#       denied" to an unauthenticated ping is alive) pages somebody — and opens
#       a public alert issue — about a perfectly good database;
#     · treating a DEAD server as healthy silently does nothing, which is the
#       exact failure the watchdog exists to end;
#     · restarting the database itself. Docker's restart policy owns recovery
#       (#3135); a `docker start` from here would undo a deliberate stop under
#       a restore, and a `docker restart` would interrupt InnoDB's own crash
#       recovery. Every test asserts the script issued no such call;
#     · dumping the container with a bare `docker inspect`, whose healthcheck
#       carries the root password, into a public Actions log.
#   All of it is shell logic, so all of it is testable without a database or a
#   Docker daemon: the tests stub `mysqladmin`, `docker` and `journalctl` on
#   PATH and assert what the script decides and which commands it issues.
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
# $STUB_STATE/ping_mode drives the fake mysqladmin: alive | denied | dead |
# recovering (dead for $STUB_STATE/dead_polls probes, then alive — what Docker
# bringing the container back looks like from the script's point of view).
# $STUB_STATE/container is the line the fake `docker inspect --format` answers.
BIN="$TMP/bin"
mkdir -p "$BIN"

# The stub is picky in exactly the way the real MariaDB client is: it accepts
# `--no-defaults` ONLY as the first argument and otherwise exits 2 with
# `unknown option`. Passing that flag second once made every probe report a
# healthy server as down.
cat > "$BIN/mysqladmin" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$STUB_STATE/mysqladmin.calls"
for i in $(seq 2 $#); do
  if [ "${!i}" = "--no-defaults" ]; then
    echo "mysqladmin: unknown option '--no-defaults'"; exit 2
  fi
done
mode="$(cat "$STUB_STATE/ping_mode" 2>/dev/null || echo alive)"
if [ "$mode" = recovering ]; then
  n="$(cat "$STUB_STATE/dead_polls" 2>/dev/null || echo 0)"
  if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$STUB_STATE/dead_polls"; mode=dead; else mode=alive; fi
fi
case "$mode" in
  alive)  echo "mysqld is alive"; exit 0 ;;
  denied) echo "mysqladmin: connect to server at '127.0.0.1' failed"
          echo "error: 'Access denied for user 'ubuntu'@'172.18.0.1' (using password: NO)'"; exit 1 ;;
  *)      echo "mysqladmin: connect to server at '127.0.0.1' failed"
          echo "error: 'Can't connect to MySQL server on '127.0.0.1:3306' (111)'"; exit 1 ;;
esac
EOF

# Every call is recorded twice: the verb alone (docker.verbs), so a test can
# assert that nothing but `inspect`/`logs` was ever issued, and in full
# (docker.calls). A bare `inspect` answers with what the real one would print —
# the healthcheck's command line, root password included — as a canary.
cat > "$BIN/docker" <<'EOF'
#!/usr/bin/env bash
echo "$1" >> "$STUB_STATE/docker.verbs"
echo "$*" >> "$STUB_STATE/docker.calls"
case "$1" in
  inspect)
    case "$*" in
      *--format*|*" -f "*) ;;
      *) echo '"Test": ["CMD", "mysqladmin", "ping", "-pCANARY-ROOT-PASSWORD"]'; exit 0 ;;
    esac
    if [ -f "$STUB_STATE/docker_down" ]; then
      echo "permission denied while trying to connect to the Docker daemon socket"; exit 1
    fi
    if [ ! -f "$STUB_STATE/container" ]; then
      echo "Error: No such object: internship-mysql"; exit 1
    fi
    cat "$STUB_STATE/container"; exit 0 ;;
  logs)
    echo "2026-10-21T14:38:09.236675Z 0 [System] [MY-010931] [Server] /usr/sbin/mysqld: ready for connections."
    exit 0 ;;
esac
exit 0
EOF

# The kernel log as the box printed it on 2026-10-21: a runner shell killed
# first, then mysqld — two lines per kill, only one of them names the victim
# in the form the script counts.
cat > "$BIN/journalctl" <<'EOF'
#!/usr/bin/env bash
cat "$STUB_STATE/kernel_log" 2>/dev/null
exit 0
EOF

# Keep the tests off the host's syslog, and fast: the wait loop's sleeps are
# accounted by WAIT_SECONDS/POLL_SECONDS, not by real time.
printf '#!/usr/bin/env bash\nexit 0\n' > "$BIN/logger"
printf '#!/usr/bin/env bash\nexit 0\n' > "$BIN/sleep"
chmod +x "$BIN"/*

KILL_MYSQLD='Oct 21 14:37:42 internshipcrm kernel: oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=fail2ban.service,mems_allowed=0,global_oom,task_memcg=/system.slice/docker-44ce.scope,task=mysqld,pid=1885,uid=999
Oct 21 14:37:42 internshipcrm kernel: Out of memory: Killed process 1885 (mysqld) total-vm:2063200kB, anon-rss:664268kB, file-rss:8kB, shmem-rss:0kB, UID:999 pgtables:3452kB oom_score_adj:0'
KILL_BASH='Oct 21 14:37:42 internshipcrm kernel: Out of memory: Killed process 1047672 (bash) total-vm:6076kB, anon-rss:976kB, file-rss:1492kB, shmem-rss:0kB, UID:1001 pgtables:48kB oom_score_adj:500'
HEALTHY='running|healthy|unless-stopped|1|2026-10-21T14:37:51.529425391Z'

# $1 = ping mode, $2 = container line ('' = no such container), rest = args.
# Sets $out, $rc, $verbs (docker verbs issued), $mutations (any verb other
# than inspect/logs), $pings (mysqladmin calls) and $dcalls.
run_watchdog() {
  local mode="$1" container="$2"; shift 2
  export STUB_STATE="$TMP/state"
  rm -rf "$STUB_STATE"; mkdir -p "$STUB_STATE"
  echo "$mode" > "$STUB_STATE/ping_mode"
  echo "${DEAD_POLLS:-0}" > "$STUB_STATE/dead_polls"
  [ -n "$container" ] && echo "$container" > "$STUB_STATE/container"
  [ -n "${KERNEL_LOG:-}" ] && printf '%s\n' "$KERNEL_LOG" > "$STUB_STATE/kernel_log"
  [ -n "${DOCKER_DOWN:-}" ] && : > "$STUB_STATE/docker_down"
  : > "$STUB_STATE/docker.verbs"; : > "$STUB_STATE/docker.calls"; : > "$STUB_STATE/mysqladmin.calls"
  out="$(PATH="$BIN:$PATH" WAIT_SECONDS=4 POLL_SECONDS=1 bash "$WATCHDOG" "$@" 2>&1)"
  rc=$?
  verbs="$(cat "$STUB_STATE/docker.verbs")"
  mutations="$(grep -vE '^(inspect|logs)$' "$STUB_STATE/docker.verbs" | tr '\n' ' ')"
  dcalls="$(cat "$STUB_STATE/docker.calls")"
  pings="$(cat "$STUB_STATE/mysqladmin.calls")"
}
ping_count() { printf '%s\n' "$pings" | grep -c ping; }

echo "mysql-watchdog.sh"

# 1. A healthy database is left completely alone — no docker call, no noise.
run_watchdog alive "$HEALTHY"
check "healthy database → exit 0" "$rc" "0"
check "healthy database logs nothing" "$out" ""
check "healthy database asks docker nothing" "$verbs" ""

# 1b. The probe must never read a ~/.my.cnf (it needs no credentials), and the
#     flag that guarantees that only works as the FIRST argument.
case "$pings" in
  "--no-defaults "*) ok "probe passes --no-defaults first, where the client accepts it" ;;
  *) bad "probe does not pass --no-defaults first (got: $pings)" ;;
esac

# 2. An unauthenticated ping answered with "Access denied" is a LIVE server.
#    This is what the box answers today (verified on s.interncrm.com).
run_watchdog denied "$HEALTHY"
check "access-denied ping → exit 0 (server answered)" "$rc" "0"
check "access-denied ping raises no alarm" "$out" ""

# 3. Docker brings it back while we wait: green, said out loud, and no restart
#    of ours — the kill is recorded, not repaired twice.
DEAD_POLLS=2 KERNEL_LOG="$KILL_MYSQLD" \
  run_watchdog recovering 'restarting|starting|unless-stopped|2|2026-10-22T20:01:02.1Z'
check "Docker restarts it during the wait → exit 0" "$rc" "0"
contains "the recovery is credited to Docker's policy" "$out" "RECOVERED"
contains "the recovery carries the kernel's verdict" "$out" "Killed process 1885 (mysqld)"
check "the watchdog itself restarted nothing" "$mutations" ""

# 4. Running but not answering for the whole window: red, with the evidence,
#    and STILL no restart — that would interrupt InnoDB's crash recovery.
KERNEL_LOG="$KILL_MYSQLD" run_watchdog dead 'running|unhealthy|unless-stopped|1|2026-10-21T14:37:51Z'
check "never answers → exit 1" "$rc" "1"
contains "says it needs a human" "$out" "needs a human"
contains "reports the container's state" "$out" "running (health: unhealthy), restart policy unless-stopped, 1 restart(s)"
contains "prints mysqld's last log lines" "$out" "ready for connections"
check "a hung database is not restarted by the watchdog" "$mutations" ""
check "it waited for Docker before calling it down" "$([ "$(ping_count)" -ge 4 ] && echo yes || echo no)" "yes"

# 5. Stopped under unless-stopped = stopped by hand. Red at once (Docker will
#    not bring it back, so waiting is pointless), and never a `docker start`:
#    that is how a restore gets a database started underneath it.
run_watchdog dead 'exited|none|unless-stopped|0|2026-10-21T14:37:51Z'
check "stopped container → exit 1" "$rc" "1"
contains "says it was most likely stopped by hand" "$out" "stopped by hand"
contains "tells the human the one command" "$out" "docker start internship-mysql"
check "a stopped database is not started by the watchdog" "$mutations" ""
check "no pointless wait for a restart Docker will not do" "$(ping_count)" "1"

# 5b. Paused is a hand-made state too; the way back is unpause, not start.
run_watchdog dead 'paused|healthy|unless-stopped|0|2026-10-21T14:37:51Z'
contains "a paused container is answered with unpause" "$out" "docker unpause internship-mysql"
check "a paused database is not touched" "$mutations" ""

# 6. Exited with no restart policy: nothing will ever bring it back.
run_watchdog dead 'exited|none|no|0|2026-10-21T14:37:51Z'
check "exited without a restart policy → exit 1" "$rc" "1"
contains "names the missing policy" "$out" "restart policy is 'no'"
contains "points at the compose file that restores it" "$out" "docker compose -f /opt/internship-crm/mysql/compose.yml up -d"

# 7. The container is gone altogether.
run_watchdog dead ''
check "missing container → exit 1" "$rc" "1"
contains "says the container is gone" "$out" "container is gone"
check "a missing container is not recreated by the watchdog" "$mutations" ""

# 8. Docker itself does not answer (permission, or the daemon is down — with
#    live-restore the container keeps running): the probe decides, and a dead
#    probe still waits and then fails, saying docker was unreachable.
DOCKER_DOWN=1 run_watchdog dead "$HEALTHY"
check "docker unreachable + database dead → exit 1" "$rc" "1"
contains "says docker did not answer" "$out" "docker did not answer"
DOCKER_DOWN=1 run_watchdog alive "$HEALTHY"
check "docker unreachable + database answering → exit 0" "$rc" "0"

# 9. --status reports and never touches anything.
KERNEL_LOG="$KILL_MYSQLD
$KILL_BASH" run_watchdog denied "$HEALTHY" --status
check "--status on a healthy box → exit 0" "$rc" "0"
contains "--status names the container and its health" "$out" "internship-mysql — running (health: healthy)"
contains "--status shows the restart policy" "$out" "restart policy:  unless-stopped"
contains "--status shows restarts with a readable timestamp" "$out" "1 since the container was created; last start 2026-10-21T14:37:51Z"
contains "--status says UP" "$out" "database:        UP"
contains "--status counts mysqld's OOM kills, not the shell's" "$out" "mysqld OOM kills in the last 24h: 1"
lacks "--status does not count another process's kill" "$out" "(bash)"
lacks "one kill is not called flapping" "$out" "flapping"
check "--status issues no mutating docker call" "$mutations" ""

run_watchdog dead "$HEALTHY" --status
check "--status on a dead database → exit 1" "$rc" "1"
contains "--status says DOWN" "$out" "database:        DOWN"
check "--status on a dead database restarts nothing" "$mutations" ""
check "--status does not wait for a restart" "$(ping_count)" "1"

KERNEL_LOG="$KILL_MYSQLD
$KILL_MYSQLD
$KILL_MYSQLD" run_watchdog denied "$HEALTHY" --status
contains "three kills in a day are called flapping" "$out" "this is flapping, not health"

run_watchdog denied 'running|healthy|no|0|2026-10-21T14:37:51Z' --status
contains "--status flags a container nothing restarts" "$out" "NOTHING restarts this database"

# 10. The container's healthcheck carries the root password. No run — healthy,
#     failed, status — may ever ask docker for an unformatted inspect.
for args in "" "--status"; do
  run_watchdog dead 'running|unhealthy|unless-stopped|1|2026-10-21T14:37:51Z' $args
  lacks "no root password in the ${args:-check} output" "$out" "CANARY-ROOT-PASSWORD"
  bare="$(printf '%s\n' "$dcalls" | grep '^inspect' | grep -v -- '--format')"
  check "every inspect in ${args:-check} mode carries --format" "$bare" ""
done

# 11. The Plesk-era install flags are refused out loud, not silently accepted.
run_watchdog alive "$HEALTHY" --install
check "--install is retired → exit 2" "$rc" "2"
contains "--install says why" "$out" "restart policy is the recovery layer"
run_watchdog alive "$HEALTHY" --uninstall
check "--uninstall is retired → exit 2" "$rc" "2"

# 12. A probe that cannot run is not a probe that says "down": mysqladmin
#     failing on its own arguments is reported and falls through to the TCP
#     check, never read as a dead database.
cat > "$BIN/mysqladmin" <<'EOF'
#!/usr/bin/env bash
echo "mysqladmin: unknown option '--some-flag'"
exit 2
EOF
chmod +x "$BIN/mysqladmin"
run_watchdog alive "$HEALTHY"
contains "an unusable mysqladmin is reported, not believed" "$out" "falling back to a TCP connect"

echo
if [ "$fail" -gt 0 ]; then
  printf '\033[31m%d failed\033[0m, %d passed\n' "$fail" "$pass"
  exit 1
fi
printf '\033[32mall %d checks passed\033[0m\n' "$pass"
