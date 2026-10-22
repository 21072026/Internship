#!/usr/bin/env bash
#
# Tests for the memory admission rules of the shared Docker host
# (infra/server/capacity.sh).
#
# WHY THIS EXISTS
#   An OOM on the box once stopped every deploy for a day (capacity.sh says
#   how). The rules that keep it from recurring only ever run on the server,
#   mid-deploy — so, like the backup and replica helpers next to this file,
#   they are pinned here, with docker and /proc/meminfo stubbed out.
#
# USAGE
#   bash infra/test/capacity.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
ok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }
eq() { # eq <label> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — expected '$2', got '$3'"; fi
}
starts() { # starts <label> <prefix> <actual>
  case "$3" in "$2"*) ok "$1" ;; *) bad "$1 — expected '$2…', got '$3'" ;; esac
}

# The defaults are part of the contract: the comments in capacity.sh and the
# README quote them.
unset TOPIC_MEMORY_MB TOPIC_HEADROOM_MB TOPIC_MAX_ENVS DEPLOY_MIN_AVAILABLE_MB
# shellcheck source=../server/capacity.sh
. "$SCRIPT_DIR/../server/capacity.sh"

printf '\nTopic admission\n'
eq     'room for container + headroom → ok'          'ok' "$(topic_capacity_verdict 4000 0 2)"
eq     'exactly the need → ok'                       'ok' "$(topic_capacity_verdict 3072 0 0)"
starts 'one MB short → deferred'                     'deferred only 3071 MB' "$(topic_capacity_verdict 3071 0 0)"
eq     "a redeploy counts its own container's memory" 'ok' "$(topic_capacity_verdict 2500 700 3)"
starts 'the cap is checked first, whatever the memory' 'deferred 8 topic environments' "$(topic_capacity_verdict 64000 0 8)"
eq     'below the cap → ok'                          'ok' "$(topic_capacity_verdict 64000 0 7)"
eq     'a redeploy is not a new environment, even over the cap' 'ok' "$(topic_capacity_verdict 64000 700 11 1)"
starts 'a redeploy is still judged on memory'        'deferred only' "$(topic_capacity_verdict 1000 200 11 1)"
starts 'a NEW environment over the cap stays deferred' 'deferred 11 topic' "$(topic_capacity_verdict 64000 0 11 0)"
eq     'unknown memory admits (the container limit still caps it)' 'ok' "$(topic_capacity_verdict '' 0 0)"
case "$(topic_capacity_verdict 1000 0 0)" in
  *"1024 MB for the container + 2048 MB kept free"*) ok 'the reason names both halves of the need' ;;
  *) bad 'the reason names both halves of the need' ;;
esac
eq 'TOPIC_MAX_ENVS is honoured' 'deferred 2 topic environments are already running (the limit is 2)' "$(TOPIC_MAX_ENVS=2 topic_capacity_verdict 64000 0 2)"
eq 'the memory knobs are honoured' 'ok' "$(TOPIC_MEMORY_MB=512 TOPIC_HEADROOM_MB=512 topic_capacity_verdict 1024 0 0)"

printf '\nDeploy preflight\n'
eq     'enough → ok'                 'ok' "$(deploy_memory_verdict 2000)"
starts 'short → refused, with the reason' 'refused only 500 MB' "$(deploy_memory_verdict 500)"
eq     'unknown memory never blocks a deploy' 'ok' "$(deploy_memory_verdict '')"
eq 'DEPLOY_MIN_AVAILABLE_MB=0 turns it off' 'ok' "$(DEPLOY_MIN_AVAILABLE_MB=0 deploy_memory_verdict 1)"

printf '\nProbes (stubbed)\n'
cat >"$TMP/meminfo" <<'EOF'
MemTotal:       24576000 kB
MemFree:          512000 kB
MemAvailable:    3145728 kB
EOF
eq 'MemAvailable is read in MB' '3072' "$(MEMINFO_FILE="$TMP/meminfo" mem_available_mb)"
printf 'MemTotal: 1 kB\n' >"$TMP/nomem"
eq 'no MemAvailable line → empty (unknown)' '' "$(MEMINFO_FILE="$TMP/nomem" mem_available_mb || true)"

docker() { # a stand-in for the two docker calls the probes make
  case "$1 $2" in
    'stats --no-stream')
      case "${!#}" in
        internship-crm-pr10) echo '512.5MiB / 1GiB' ;;
        internship-crm-pr11) echo '1.5GiB / 2GiB' ;;
        internship-crm-pr12) echo '800KiB / 1GiB' ;;
        *) return 1 ;;
      esac ;;
    'ps --format')
      printf '%s\n' internship-crm internship-crm-preview internship-crm-pr10 internship-crm-pr11 internship-mail-sink internship-crm-pr12-old ;;
  esac
}
eq 'MiB usage'                     '512'  "$(container_mem_mb internship-crm-pr10)"
eq 'GiB usage'                     '1536' "$(container_mem_mb internship-crm-pr11)"
eq 'KiB usage rounds down'         '0'    "$(container_mem_mb internship-crm-pr12)"
eq 'a missing container uses 0'    '0'    "$(container_mem_mb internship-crm-pr99)"
eq 'only internship-crm-pr<N> counts, minus the PR itself' '1' "$(topic_containers_except internship-crm-pr10)"
eq 'a new PR sees every topic container' '2' "$(topic_containers_except internship-crm-pr77)"
eq 'its own running container is seen'   '1' "$(container_running internship-crm-pr10)"
eq 'a name prefix is not a match'        '0' "$(container_running internship-crm-pr1)"
eq 'a PR without a container'            '0' "$(container_running internship-crm-pr77)"
docker() { [ "$1" = ps ] && return 0; return 1; }
eq 'an empty box counts 0 (and survives pipefail)' '0' "$(set -o pipefail; topic_containers_except internship-crm-pr1)"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
