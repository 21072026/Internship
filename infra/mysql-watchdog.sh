#!/usr/bin/env bash
#
# MySQL watchdog for the Docker host — the half that looks from outside.
#
# WHY THIS EXISTS
#   The database keeps getting OOM-killed. The kernel picks mysqld (normally the
#   largest process on the box) and SIGKILLs it, and the app keeps running
#   against a database that is not there, so every page that touches data is an
#   error until it is back. On the retired Plesk box the packaged systemd unit
#   then simply stayed down, and this script used to install a restart drop-in
#   and a once-a-minute timer that started it again.
#
#   The current box runs MySQL 8 in the container `internship-mysql`
#   (infra/server/bootstrap.sh) with `restart: unless-stopped`, and Docker does
#   that job itself. The kill that prompted this rewrite is the proof: on
#   2026-10-21 at 14:37:42 the kernel OOM-killed mysqld, Docker had the
#   container running again at 14:37:51 and it took connections at 14:38:09 —
#   no unit, no timer, no human (#3135). So nothing here restarts the database
#   any more. What is left is the part Docker cannot do:
#     · tell somebody. Docker restarts quietly, and a database that is down and
#       STAYING down is only noticed if something outside the box looks. That is
#       .github/workflows/mysql-watchdog.yml: it runs this script over SSH from
#       a GitHub-HOSTED runner and turns exit 1 into an alert issue;
#     · keep the evidence. A kill Docker repaired in nine seconds leaves no
#       trace anyone reads, so --status prints the kernel's OOM lines, the
#       container's restart count and a memory snapshot.
#
# WHY IT NEVER RESTARTS THE DATABASE ITSELF
#   Under `unless-stopped` a database that is down is in one of three states,
#   and a restart from here makes none of them better:
#     1. Docker is restarting it (a crash, an OOM kill). It is already doing
#        the one thing we would do; the check waits WAIT_SECONDS for it.
#     2. Somebody stopped it (`docker stop`, `docker compose stop`). Docker
#        records that as deliberate and leaves it alone, and so must we:
#        starting a database underneath a restore or a migration is how a
#        restore gets corrupted. The alert tells a human it is still stopped.
#     3. It is running but not answering: InnoDB replaying its redo log after a
#        kill, or a box swapping itself to a standstill. A restart there
#        interrupts the very recovery it is waiting for, and loops.
#
# WHAT COUNTS AS ALIVE
#   The server answering the protocol on the port bootstrap.sh publishes
#   (127.0.0.1:3306) — not our ability to log in. A `mysqladmin ping` that comes
#   back "Access denied" is a HEALTHY server refusing an unauthenticated client;
#   reading that as down would page somebody about a perfectly good database.
#   No credentials are read, stored, or needed anywhere in this file.
#
# USAGE
#   ./infra/mysql-watchdog.sh            # one check: exit 0 up, 1 down
#   ./infra/mysql-watchdog.sh --status   # report only (container, restarts, OOM kills, memory)
#
#   ENV VARS
#     MYSQL_CONTAINER  default internship-mysql
#     MYSQL_HOST       default 127.0.0.1
#     MYSQL_PORT       default 3306
#     WAIT_SECONDS     how long Docker's own restart gets before "down", default 120
#     POLL_SECONDS     gap between liveness polls while waiting, default 5
#
#   The user running it needs the `docker` group (to read the container's
#   state) and `adm` (to read the kernel log). No sudo.
#
# Exit 0 = the database is up (it never went down, or Docker brought it back
# while we waited). Exit 1 = it is down and not coming back on its own — the
# only case worth waking someone for. Exit 2 = bad usage.
set -uo pipefail

MYSQL_CONTAINER="${MYSQL_CONTAINER:-internship-mysql}"
MYSQL_HOST="${MYSQL_HOST:-127.0.0.1}"
MYSQL_PORT="${MYSQL_PORT:-3306}"
WAIT_SECONDS="${WAIT_SECONDS:-120}"
POLL_SECONDS="${POLL_SECONDS:-5}"
MODE="check"

TAG="internship-mysql-watchdog"
COMPOSE_FILE="/opt/internship-crm/mysql/compose.yml"

while [ $# -gt 0 ]; do
  case "$1" in
    --status) MODE="status"; shift ;;
    --check) MODE="check"; shift ;;
    # The Plesk-era timer and systemd drop-in. Refused out loud rather than
    # treated as an unknown flag, for whoever arrives here from an old runbook.
    --install|--uninstall)
      echo "$1 is retired: on the Docker host the container's restart policy is the recovery layer (#3135)." >&2
      echo "There is nothing to install. See infra/README.md → \"MySQL watchdog\"." >&2
      exit 2 ;;
    -h|--help) sed -n '2,64p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

# ── logging ───────────────────────────────────────────────────────────────────
# stdout is what the workflow captures (and what lands in the alert issue); the
# journal line is for whoever is on the box afterwards:
# `journalctl -t internship-mysql-watchdog`.
log() {
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"
  command -v logger >/dev/null 2>&1 && logger -t "$TAG" -- "$*"
  return 0
}

have() { command -v "$1" >/dev/null 2>&1; }

# ── liveness ──────────────────────────────────────────────────────────────────
# Classify one mysqladmin run: up / down / unusable.
#   up       — the server answered (including an authentication refusal)
#   down     — the server did not answer
#   unusable — mysqladmin itself could not be asked (wrong option, missing
#              library). NOT the same as "down": the TCP probe decides those.
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

# Two probes, because each one alone has a blind spot:
#   · mysqladmin (the host's mysql-client, installed by bootstrap.sh) speaks the
#     protocol, so it knows "no listener" from "listening but not accepting me";
#   · a bare TCP connect is always available but is weak on a Docker host:
#     docker-proxy holds the published port open for as long as the container
#     runs, so it accepts a connection even when mysqld inside does not answer.
#     It is only the fallback for when mysqladmin cannot give a verdict.
db_is_up() {
  local out rc verdict
  if have mysqladmin; then
    # `--no-defaults` MUST be the first argument: MariaDB's client rejects it
    # anywhere else with `unknown option '--no-defaults'` and exits 2, which
    # made every probe report a healthy server as down. It is here so the probe
    # never picks up credentials from a ~/.my.cnf.
    out="$(mysqladmin --no-defaults --connect-timeout=5 \
            --host="$MYSQL_HOST" --port="$MYSQL_PORT" --protocol=TCP ping 2>&1)"
    rc=$?
    verdict="$(classify_ping "$rc" "$out")"
    [ "$verdict" = up ] && return 0
    if [ "$verdict" = unusable ]; then
      log "probe: mysqladmin could not be used (${out%%$'\n'*}) — falling back to a TCP connect"
    else
      return 1
    fi
  fi
  (exec 3<>"/dev/tcp/$MYSQL_HOST/$MYSQL_PORT") >/dev/null 2>&1
}

# ── the container ─────────────────────────────────────────────────────────────
# Always an explicit --format, never a bare `docker inspect`: the container's
# healthcheck carries the root password on its command line, and a full dump
# would put it into a public Actions log and an alert issue.
C_STATE="unknown"; C_HEALTH="-"; C_POLICY="-"; C_RESTARTS="-"; C_STARTED="-"; C_NOTE=""
read_container() {
  local out rc
  if ! have docker; then C_NOTE="docker is not installed here"; return 1; fi
  out="$(docker inspect --format \
    '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.HostConfig.RestartPolicy.Name}}|{{.RestartCount}}|{{.State.StartedAt}}' \
    "$MYSQL_CONTAINER" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    case "$out" in
      *"No such object"*|*"No such container"*) C_STATE="missing" ;;
      # Permission denied, or the daemon is down. With live-restore on (it is,
      # on this box) a daemon outage does not stop the containers, so this says
      # nothing about the database — the probe decides.
      *) C_STATE="unknown"; C_NOTE="docker did not answer: ${out%%$'\n'*}" ;;
    esac
    return 1
  fi
  IFS='|' read -r C_STATE C_HEALTH C_POLICY C_RESTARTS C_STARTED <<EOF
$out
EOF
  # 2026-10-21T14:37:51.529425391Z → 2026-10-21T14:37:51Z
  C_STARTED="$(printf '%s' "$C_STARTED" | sed 's/\.[0-9]*Z$/Z/')"
  return 0
}

# A policy that restarts a crashed container. `no` (a container recreated by
# hand with `docker run`) leaves the database down after the next kill.
policy_restarts() {
  case "$C_POLICY" in always|unless-stopped|on-failure) return 0 ;; *) return 1 ;; esac
}

# ── OOM forensics ─────────────────────────────────────────────────────────────
# Docker's own `State.OOMKilled` is NOT the evidence: the container has no
# memory limit, so a kill comes from the host-wide OOM killer, and Docker sets
# that flag only for a kill by the container's own limit. On 2026-10-21 it read
# `false` for a container whose mysqld the kernel had just killed. The kernel
# log is the record; one "Killed process <pid> (mysqld)" line per kill.
oom_kills() {
  local since="$1"
  if have journalctl; then
    journalctl -k --since "$since" --no-pager 2>/dev/null
  elif [ -r /var/log/kern.log ]; then
    cat /var/log/kern.log 2>/dev/null
  fi | grep -iE 'killed process [0-9]+ \((mysqld|mariadbd)\)' | tail -5
}

memory_snapshot() {
  have free && free -m | sed 's/^/    /'
  # Process names and RSS only — no arguments, which on this box can carry
  # database URLs and other credentials into a log and an issue.
  if have ps; then
    echo "    top memory consumers (RSS MB):"
    ps -eo rss=,comm= --sort=-rss 2>/dev/null | head -6 \
      | awk '{ printf "      %6.0f  %s\n", $1/1024, $2 }'
  fi
}

# mysqld's own last words. Its error log carries InnoDB recovery, a full disk,
# a corrupt table — never a password (the entrypoint prints one only for a
# random root password, which bootstrap.sh does not use, and only at init).
last_words() {
  have docker || return 0
  docker logs --tail 20 "$MYSQL_CONTAINER" 2>&1 | cut -c1-300 | sed 's/^/    /'
}

describe_container() {
  if [ "$C_STATE" = "missing" ]; then
    echo "container $MYSQL_CONTAINER does not exist"
  else
    echo "container $MYSQL_CONTAINER: $C_STATE (health: $C_HEALTH), restart policy $C_POLICY, ${C_RESTARTS} restart(s), last start $C_STARTED${C_NOTE:+ — $C_NOTE}"
  fi
}

# ── --status ──────────────────────────────────────────────────────────────────
if [ "$MODE" = "status" ]; then
  read_container
  echo "host:            $(hostname 2>/dev/null || echo unknown)"
  if [ "$C_STATE" = "missing" ]; then
    echo "container:       $MYSQL_CONTAINER — DOES NOT EXIST"
  else
    echo "container:       $MYSQL_CONTAINER — $C_STATE (health: $C_HEALTH)${C_NOTE:+ — $C_NOTE}"
    if [ "$C_POLICY" = "-" ]; then
      echo "restart policy:  unknown"
    elif policy_restarts; then
      echo "restart policy:  $C_POLICY"
    else
      echo "restart policy:  $C_POLICY — NOTHING restarts this database after a crash; \`docker compose -f $COMPOSE_FILE up -d\` restores bootstrap.sh's unless-stopped"
    fi
    echo "restarts:        $C_RESTARTS since the container was created; last start $C_STARTED"
  fi
  if db_is_up; then up=0; echo "database:        UP (answers on $MYSQL_HOST:$MYSQL_PORT)"
  else up=1; echo "database:        DOWN (no answer on $MYSQL_HOST:$MYSQL_PORT)"; fi
  kills="$(oom_kills '-24 hours')"
  if [ -n "$kills" ]; then
    n="$(printf '%s\n' "$kills" | wc -l | tr -d ' ')"
    echo "mysqld OOM kills in the last 24h: $n"
    printf '%s\n' "$kills" | sed 's/^/    /'
    if [ "$n" -ge 3 ]; then
      # Docker brought it back each time, which is exactly why nobody noticed.
      echo "WARNING: $n kills in a day — Docker keeps restarting it, but this is flapping, not health."
      echo "         Give the box memory headroom (infra/README.md → \"MySQL watchdog\")."
    fi
  else
    echo "mysqld OOM kills in the last 24h: none found"
  fi
  memory_snapshot
  exit "$up"
fi

# ── the check itself ──────────────────────────────────────────────────────────
if db_is_up; then
  # Healthy is the overwhelmingly common case: stay silent.
  exit 0
fi

log "ALERT: the database is not answering on $MYSQL_HOST:$MYSQL_PORT"
read_container
log "$(describe_container)"

case "$C_STATE" in
  # Docker will not bring these back by itself, so waiting is pointless and the
  # state is the message.
  missing)
    log "FAILED: the container is gone — \`docker compose -f $COMPOSE_FILE up -d\` recreates it (the data volume outlives the container)"
    memory_snapshot
    exit 1 ;;
  exited|created|dead|paused)
    if policy_restarts; then
      # Docker restarts a container that crashes and leaves one that was
      # stopped (or paused) by hand, so this state under this policy is almost
      # always a `docker stop` nobody undid. Undoing it is a human's call.
      undo="start"; [ "$C_STATE" = "paused" ] && undo="unpause"
      log "FAILED: $MYSQL_CONTAINER is $C_STATE and Docker is not restarting it — most likely stopped by hand."
      log "        Once whatever stopped it is finished: \`docker $undo $MYSQL_CONTAINER\`"
    else
      log "FAILED: $MYSQL_CONTAINER is $C_STATE and its restart policy is '$C_POLICY', so nothing will restart it."
      log "        \`docker compose -f $COMPOSE_FILE up -d\` brings it back with bootstrap.sh's unless-stopped"
    fi
    last_words
    exit 1 ;;
esac

# running / restarting / unknown: give Docker's restart (or InnoDB's crash
# recovery) its time before calling it down.
waited=0
while [ "$waited" -lt "$WAIT_SECONDS" ]; do
  sleep "$POLL_SECONDS"
  waited=$((waited + POLL_SECONDS))
  if db_is_up; then
    read_container
    log "RECOVERED: answering again after ${waited}s without us — Docker's restart policy ($(describe_container))"
    kills="$(oom_kills '-1 hour')"
    if [ -n "$kills" ]; then
      log "cause: the kernel OOM-killed it —"
      printf '%s\n' "$kills" | sed 's/^/    /'
    fi
    exit 0
  fi
done

read_container
log "FAILED: still not answering after ${WAIT_SECONDS}s — needs a human ($(describe_container))"
kills="$(oom_kills '-1 hour')"
if [ -n "$kills" ]; then
  log "the kernel OOM-killed it in the last hour —"
  printf '%s\n' "$kills" | sed 's/^/    /'
fi
memory_snapshot
echo "    mysqld's last log lines:"
last_words
exit 1
