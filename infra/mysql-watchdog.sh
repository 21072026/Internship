#!/usr/bin/env bash
#
# MySQL/MariaDB watchdog for the Plesk box.
#
# WHY THIS EXISTS
#   The database server is being OOM-killed. The kernel picks mysqld as its
#   victim, the unit stops, and the app keeps running against a database that
#   is no longer there — so every page turns into an error until somebody
#   notices and types `service mysql start`. The recovery is trivial; the
#   detection is what takes hours. This script is the detection.
#
#   It is deliberately NOT the only line of defence, because a watchdog that
#   polls once a minute still leaves up to a minute of downtime:
#     1. `--install` writes a systemd drop-in for the MySQL unit itself
#        (Restart=always + no start-rate limit + a friendlier OOM score), so
#        systemd brings the server back in seconds without waiting for us;
#     2. the timer installed alongside it runs this check every minute and
#        starts the unit whenever layer 1 did not (unit left in `inactive`
#        after too many restarts, a start that failed on a transient, a
#        `stop` nobody meant to leave behind);
#     3. .github/workflows/mysql-watchdog.yml watches from OUTSIDE the box and
#        emails when the database is down and this script could not fix it —
#        an alert that needs the sick server to be healthy is not an alert.
#
# WHAT COUNTS AS ALIVE
#   The server answering the protocol — not our ability to log in. A
#   `mysqladmin ping` that comes back "Access denied" is a HEALTHY server
#   refusing an unauthenticated client, and treating that as down would make
#   the watchdog restart a perfectly good database in a loop. No credentials
#   are read, stored, or needed anywhere in this file.
#
# USAGE
#   ./infra/mysql-watchdog.sh                 # one health check (+ recovery)
#   ./infra/mysql-watchdog.sh --status        # report only, never touch anything
#   ./infra/mysql-watchdog.sh --install       # systemd timer + unit hardening
#   ./infra/mysql-watchdog.sh --uninstall     # remove both again
#
#   ENV VARS
#     MYSQL_UNIT      systemd unit; auto-detected (mariadb/mysql/mysqld)
#     MYSQL_HOST      default 127.0.0.1
#     MYSQL_PORT      default 3306
#     MYSQL_SOCKET    default /var/run/mysqld/mysqld.sock (probed if absent)
#     WAIT_SECONDS    how long to wait for a start to take effect, default 60
#     ATTEMPTS        start attempts per run, default 3
#     LOG_FILE        default /var/log/internship-crm/mysql-watchdog.log
#     STATE_DIR       default /var/lib/internship-crm  (flap counter)
#     INTERVAL        timer period for --install, default 1min
#     POLL_SECONDS    gap between liveness polls while waiting, default 3
#     SYSTEMD_DIR     where units are written, default /etc/systemd/system
#     SYSTEMD_RUN_DIR /run/systemd/system — its existence is how "is systemd
#                     actually running this machine" is decided
#     INITD_DIR       default /etc/init.d (the no-systemd fallback)
#                     The last three are overridden only by
#                     infra/test/mysql-watchdog.test.sh.
#
# Exit 0 = the database is up (either it never went down, or we brought it
# back). Exit 1 = it is down and this run could not fix it — that is the only
# case worth waking someone for. Exit 2 = bad usage.
set -uo pipefail

MYSQL_HOST="${MYSQL_HOST:-127.0.0.1}"
MYSQL_PORT="${MYSQL_PORT:-3306}"
MYSQL_SOCKET="${MYSQL_SOCKET:-/var/run/mysqld/mysqld.sock}"
WAIT_SECONDS="${WAIT_SECONDS:-60}"
ATTEMPTS="${ATTEMPTS:-3}"
LOG_FILE="${LOG_FILE:-/var/log/internship-crm/mysql-watchdog.log}"
STATE_DIR="${STATE_DIR:-/var/lib/internship-crm}"
INTERVAL="${INTERVAL:-1min}"
POLL_SECONDS="${POLL_SECONDS:-3}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
# `systemctl` being installed does not mean systemd is running the machine — in
# a container it is present and answers every call with "System has not been
# booted with systemd". This directory exists only when systemd is PID 1, which
# is the question actually being asked.
SYSTEMD_RUN_DIR="${SYSTEMD_RUN_DIR:-/run/systemd/system}"
INITD_DIR="${INITD_DIR:-/etc/init.d}"
MODE="check"

WATCHDOG_UNIT="internship-mysql-watchdog"
DROPIN_NAME="10-internship-oom.conf"

while [ $# -gt 0 ]; do
  case "$1" in
    --status) MODE="status"; shift ;;
    --install) MODE="install"; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    --check) MODE="check"; shift ;;
    --unit) MYSQL_UNIT="${2:?--unit needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,55p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

# ── logging ───────────────────────────────────────────────────────────────────
# Everything goes to stdout (so the systemd journal and the CI job both see it)
# and, when the directory is writable, to a file that survives a journal roll.
log() {
  local line
  line="$(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"
  echo "$line"
  if mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null && touch "$LOG_FILE" 2>/dev/null; then
    echo "$line" >> "$LOG_FILE"
  fi
  command -v logger >/dev/null 2>&1 && logger -t "$WATCHDOG_UNIT" -- "$*"
  return 0
}

have() { command -v "$1" >/dev/null 2>&1; }
systemd_ok() { have systemctl && [ -d "$SYSTEMD_RUN_DIR" ]; }
as_root() { [ "$(id -u)" = "0" ]; }
# Plesk's runner user may not be root; every privileged call goes through here
# so a non-root install fails with a clear message instead of a confusing one.
sudo_if_needed() {
  if as_root; then "$@"; elif have sudo; then sudo -n "$@"; else return 127; fi
}

# ── which unit is the database ────────────────────────────────────────────────
# Debian/Ubuntu ships `mysql.service`, MariaDB `mariadb.service`, RHEL
# `mysqld.service`, and on several Plesk builds one is an alias of the other.
# Ask systemd rather than guessing from the distro.
detect_unit() {
  [ -n "${MYSQL_UNIT:-}" ] && { echo "$MYSQL_UNIT"; return 0; }
  local candidate
  if systemd_ok; then
    for candidate in mariadb mysql mysqld mysql-server; do
      if systemctl cat "$candidate.service" >/dev/null 2>&1; then
        echo "$candidate"
        return 0
      fi
    done
    return 1
  fi
  # No systemd (a container, an older box): fall back to the SysV script, which
  # is what `service mysql start` drives. Recovery still works; only --install
  # needs systemd, and it says so.
  for candidate in mariadb mysql mysqld; do
    if [ -x "$INITD_DIR/$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

# One call site for "start the database", so the systemd and SysV paths cannot
# drift apart.
start_unit() {
  local unit="$1"
  if systemd_ok; then
    sudo_if_needed systemctl start "$unit.service" >/dev/null 2>&1
  else
    sudo_if_needed service "$unit" start >/dev/null 2>&1
  fi
}

# ── liveness ──────────────────────────────────────────────────────────────────
# Two independent probes, because each one alone has a blind spot:
#   · mysqladmin speaks the protocol, so it knows the difference between "no
#     listener" and "listening but not accepting me" — but it may be absent;
#   · a bare TCP connect is always available but cannot tell a listening socket
#     from a working server. Used only as the fallback.
# Classify one mysqladmin run: up / down / unusable.
#   up       — the server answered (including an authentication refusal)
#   down     — the server did not answer
#   unusable — mysqladmin itself could not be asked (wrong option, missing
#              library). NOT the same as "down", and treating it as down is how
#              a watchdog ends up restarting a perfectly healthy database once a
#              minute; the TCP probe decides those cases instead.
classify_ping() {
  local rc="$1" out="$2"
  [ "$rc" -eq 0 ] && { echo up; return; }
  case "$out" in
    # 1045 access denied / 1044 no rights / 1226 quota: the server answered,
    # which is the only thing this check is asking about.
    *"Access denied"*|*"ERROR 1045"*|*"ERROR 1044"*|*"ERROR 1226"*) echo up ;;
    *"unknown option"*|*"unknown variable"*|*"Usage:"*|*"error while loading shared libraries"*) echo unusable ;;
    *"connect to server"*|*"Can't connect"*|*"Connection refused"*|*"ERROR 2002"*|*"ERROR 2003"*) echo down ;;
    *) echo unusable ;;
  esac
}

# Two independent probes, because each one alone has a blind spot:
#   · mysqladmin speaks the protocol, so it knows the difference between "no
#     listener" and "listening but not accepting me" — but it may be absent, or
#     refuse the options we pass it;
#   · a bare TCP connect is always available but cannot tell a listening socket
#     from a working server. Used when mysqladmin cannot give a verdict.
db_is_up() {
  local out rc verdict
  if have mysqladmin; then
    # `--no-defaults` MUST be the first argument: MariaDB's client rejects it
    # anywhere else with `unknown option '--no-defaults'` and exits 2. That is
    # not a hypothetical — it made every probe report a healthy server as down.
    # It is here so the probe never picks up credentials from a ~/.my.cnf.
    out="$(mysqladmin --no-defaults --connect-timeout=5 \
            --host="$MYSQL_HOST" --port="$MYSQL_PORT" --protocol=TCP ping 2>&1)"
    rc=$?
    verdict="$(classify_ping "$rc" "$out")"
    [ "$verdict" = up ] && return 0

    # A socket-only server (skip-networking) is still healthy; try that path
    # before believing the TCP answer.
    if [ -S "$MYSQL_SOCKET" ]; then
      out="$(mysqladmin --no-defaults --connect-timeout=5 --socket="$MYSQL_SOCKET" ping 2>&1)"
      rc=$?
      [ "$(classify_ping "$rc" "$out")" = up ] && return 0
    fi

    if [ "$verdict" = unusable ]; then
      log "probe: mysqladmin could not be used (${out%%$'\n'*}) — falling back to a TCP connect"
    else
      return 1
    fi
  fi
  # Fallback: can anything connect to the port at all?
  (exec 3<>"/dev/tcp/$MYSQL_HOST/$MYSQL_PORT") >/dev/null 2>&1
}

# ── OOM forensics ─────────────────────────────────────────────────────────────
# The restart is the easy half. Without this the maintainer gets "MySQL was
# down again" every few days with no idea why, so every recovery carries the
# kernel's own verdict and the memory picture at the time.
oom_evidence() {
  local since="${1:--30 min}"
  if have journalctl; then
    journalctl -k --since "$since" --no-pager 2>/dev/null \
      | grep -iE 'out of memory: kill|oom-kill' \
      | grep -iE 'mysqld|mariadbd|mysql' | tail -5
  elif [ -r /var/log/kern.log ]; then
    grep -iE 'out of memory: kill|oom-kill' /var/log/kern.log 2>/dev/null \
      | grep -iE 'mysqld|mariadbd|mysql' | tail -5
  fi
}

memory_snapshot() {
  have free && free -m | sed 's/^/    /'
  # Process names and RSS only — no arguments, which on this box can carry
  # database URLs and other credentials into a log file and an email.
  if have ps; then
    echo "    top memory consumers (RSS MB):"
    ps -eo rss=,comm= --sort=-rss 2>/dev/null | head -6 \
      | awk '{ printf "      %6.0f  %s\n", $1/1024, $2 }'
  fi
}

# ── flap accounting ───────────────────────────────────────────────────────────
# A database that is restarted five times an hour is not "recovered", it is
# broken in a way a watchdog cannot fix — and saying so is the difference
# between a useful alert and a soothing one.
record_restart() {
  mkdir -p "$STATE_DIR" 2>/dev/null || return 0
  local f="$STATE_DIR/mysql-watchdog.restarts"
  local now cutoff
  now="$(date -u +%s)"
  cutoff=$((now - 3600))
  { [ -f "$f" ] && awk -v c="$cutoff" '$1 > c' "$f"; echo "$now"; } > "$f.tmp" 2>/dev/null \
    && mv "$f.tmp" "$f" 2>/dev/null
  wc -l < "$f" 2>/dev/null | tr -d ' '
}

start_database() {
  local unit="$1" attempt waited
  for attempt in $(seq 1 "$ATTEMPTS"); do
    log "recovery: attempt $attempt/$ATTEMPTS — starting $unit"
    if ! start_unit "$unit"; then
      # `systemctl start` returning non-zero is not itself conclusive: it can
      # time out while the server is still replaying the redo log. Keep polling.
      log "recovery: the start command returned non-zero (server may still be coming up)"
    fi
    waited=0
    while [ "$waited" -lt "$WAIT_SECONDS" ]; do
      if db_is_up; then
        log "recovery: database is answering again after ${waited}s"
        return 0
      fi
      sleep "$POLL_SECONDS"
      waited=$((waited + POLL_SECONDS))
    done
    log "recovery: still down after ${WAIT_SECONDS}s"
  done
  return 1
}

# ── systemd assets written by --install ───────────────────────────────────────
install_dropin() {
  local unit="$1"
  local dir="$SYSTEMD_DIR/${unit}.service.d"
  sudo_if_needed mkdir -p "$dir" || return 1
  # Written through a temp file because the heredoc is produced as the calling
  # (possibly unprivileged) user and only then moved into place with sudo.
  local tmp; tmp="$(mktemp)"
  cat > "$tmp" <<EOF
# Managed by infra/mysql-watchdog.sh — do not edit by hand.
#
# The packaged unit gives up after a few rapid restarts (StartLimitBurst) and,
# on some builds, does not restart at all after a SIGKILL — which is exactly
# what an OOM kill is. Both defaults are wrong for a database that is being
# OOM-killed: giving up is the one outcome that requires a human.
[Unit]
StartLimitIntervalSec=0

[Service]
Restart=always
RestartSec=10s
# Ask the kernel to look elsewhere for a victim. It is a bias, not immunity:
# the OOM killer still scores by memory used, and mysqld is usually the largest
# process on the box — so this reduces the frequency, it does not end it. The
# real fix is memory headroom (swap, or a smaller innodb_buffer_pool_size).
OOMScoreAdjust=-500
# Never let a cgroup-level OOM event stop the unit outright (systemd >= 243;
# older versions ignore the key with a warning, which is harmless).
OOMPolicy=continue
EOF
  sudo_if_needed install -m 0644 "$tmp" "$dir/$DROPIN_NAME" || { rm -f "$tmp"; return 1; }
  rm -f "$tmp"
  log "install: wrote $dir/$DROPIN_NAME"
}

install_timer() {
  local script_path; script_path="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  local tmp; tmp="$(mktemp)"
  cat > "$tmp" <<EOF
# Managed by infra/mysql-watchdog.sh — do not edit by hand.
[Unit]
Description=Internship CRM — MySQL watchdog (restart the database if it is down)
Documentation=https://github.com/21072026/Internship/blob/main/infra/README.md
After=network.target

[Service]
Type=oneshot
ExecStart=$script_path --check
# The check itself must never be the thing that hangs: a run that outlives its
# own interval would stack timers on top of each other.
TimeoutStartSec=300
EOF
  sudo_if_needed install -m 0644 "$tmp" "$SYSTEMD_DIR/$WATCHDOG_UNIT.service" || { rm -f "$tmp"; return 1; }

  cat > "$tmp" <<EOF
# Managed by infra/mysql-watchdog.sh — do not edit by hand.
[Unit]
Description=Internship CRM — MySQL watchdog timer

[Timer]
# One minute after boot, then every $INTERVAL. AccuracySec keeps systemd from
# coalescing the run into a lazy wake-up window minutes later.
OnBootSec=1min
OnUnitActiveSec=$INTERVAL
AccuracySec=5s
Unit=$WATCHDOG_UNIT.service

[Install]
WantedBy=timers.target
EOF
  sudo_if_needed install -m 0644 "$tmp" "$SYSTEMD_DIR/$WATCHDOG_UNIT.timer" || { rm -f "$tmp"; return 1; }
  rm -f "$tmp"
  log "install: wrote $SYSTEMD_DIR/$WATCHDOG_UNIT.{service,timer}"
}

# ── modes ─────────────────────────────────────────────────────────────────────
UNIT="$(detect_unit)" || UNIT=""

case "$MODE" in
  status)
    if [ -n "$UNIT" ] && systemd_ok; then
      echo "unit:        $UNIT.service ($(systemctl is-active "$UNIT.service" 2>/dev/null || echo unknown))"
      echo "unit enabled: $(systemctl is-enabled "$UNIT.service" 2>/dev/null || echo unknown)"
      echo "hardening:   $([ -f "$SYSTEMD_DIR/${UNIT}.service.d/$DROPIN_NAME" ] && echo installed || echo MISSING)"
      echo "timer:       $(systemctl is-active "$WATCHDOG_UNIT.timer" 2>/dev/null || echo inactive) / $(systemctl is-enabled "$WATCHDOG_UNIT.timer" 2>/dev/null || echo disabled)"
    else
      echo "unit:        ${UNIT:-not detected} (no systemd — SysV \`service\` path)"
    fi
    if db_is_up; then echo "database:    UP"; else echo "database:    DOWN"; fi
    evidence="$(oom_evidence '-24 hours')"
    if [ -n "$evidence" ]; then
      echo "OOM kills in the last 24h:"
      echo "$evidence" | sed 's/^/    /'
    else
      echo "OOM kills in the last 24h: none found"
    fi
    memory_snapshot
    db_is_up
    exit $?
    ;;

  install)
    systemd_ok || { log "install: systemd is not running this machine — install a cron entry instead (see infra/README.md)"; exit 1; }
    [ -n "$UNIT" ] || { log "install: could not detect the MySQL unit; pass --unit <name>"; exit 1; }
    install_dropin "$UNIT" || { log "install: FAILED to write the drop-in (need root or passwordless sudo)"; exit 1; }
    install_timer || { log "install: FAILED to write the timer (need root or passwordless sudo)"; exit 1; }
    sudo_if_needed systemctl daemon-reload || { log "install: daemon-reload failed"; exit 1; }
    sudo_if_needed systemctl enable --now "$WATCHDOG_UNIT.timer" >/dev/null 2>&1 \
      || { log "install: could not enable the timer"; exit 1; }
    # The database unit itself must also survive a reboot; an OOM kill on a box
    # whose mysql is `disabled` is a reboot away from staying down for good.
    sudo_if_needed systemctl enable "$UNIT.service" >/dev/null 2>&1 || true
    log "install: watchdog active for $UNIT.service (every $INTERVAL)"
    exit 0
    ;;

  uninstall)
    systemd_ok || exit 0
    sudo_if_needed systemctl disable --now "$WATCHDOG_UNIT.timer" >/dev/null 2>&1
    sudo_if_needed rm -f "$SYSTEMD_DIR/$WATCHDOG_UNIT.timer" "$SYSTEMD_DIR/$WATCHDOG_UNIT.service"
    [ -n "$UNIT" ] && sudo_if_needed rm -f "$SYSTEMD_DIR/${UNIT}.service.d/$DROPIN_NAME"
    sudo_if_needed systemctl daemon-reload >/dev/null 2>&1
    log "uninstall: watchdog removed"
    exit 0
    ;;
esac

# ── the check itself ──────────────────────────────────────────────────────────
if db_is_up; then
  # Healthy is the overwhelmingly common case and it runs every minute: stay
  # silent so the log keeps only the interesting lines.
  exit 0
fi

log "ALERT: the database is not answering on $MYSQL_HOST:$MYSQL_PORT"
evidence="$(oom_evidence '-30 min')"
if [ -n "$evidence" ]; then
  log "cause: the kernel OOM-killed it —"
  echo "$evidence" | sed 's/^/    /' | tee -a "$LOG_FILE" 2>/dev/null
fi
memory_snapshot | tee -a "$LOG_FILE" 2>/dev/null

if [ -z "$UNIT" ]; then
  log "FAILED: no MySQL service detected (no systemd unit, no /etc/init.d script) — cannot restart it"
  exit 1
fi

if start_database "$UNIT"; then
  count="$(record_restart)"
  log "RECOVERED: $UNIT is up again (restart #${count:-?} in the last hour)"
  if [ -n "${count:-}" ] && [ "$count" -ge 3 ] 2>/dev/null; then
    # Recovered, but say plainly that the recovery is papering over something.
    log "WARNING: ${count} restarts in the last hour — this is flapping, not health."
    log "         Give the box memory headroom (swap, or lower innodb_buffer_pool_size)."
  fi
  exit 0
fi

log "FAILED: $UNIT is still down after $ATTEMPTS attempts — needs a human"
if systemd_ok; then
  sudo_if_needed systemctl status "$UNIT.service" --no-pager -l 2>&1 | tail -20 | sed 's/^/    /'
  sudo_if_needed journalctl -u "$UNIT.service" -n 30 --no-pager 2>&1 | tail -30 | sed 's/^/    /'
fi
exit 1
