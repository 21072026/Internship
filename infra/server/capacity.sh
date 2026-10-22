#!/usr/bin/env bash
#
# Memory admission for the shared Docker host — sourced, never run.
#
# WHY THIS EXISTS
#   One box runs prod, the shared preview, MySQL and one container per open PR
#   (topic-preview.yml). On 2026-10-21 a preview deploy's tool container was
#   OOM-killed mid-`prisma db push` (exit 137) while many topic
#   environments were up; the self-hosted runner never took another job, and
#   every deploy — prod's included — queued behind it for a day. Nothing said
#   "the server is full"; it just stopped.
#
#   So a topic environment is now ADMITTED, not assumed: before anything is
#   pulled or created, topic-deploy.sh asks topic_capacity_verdict() whether the
#   box has room for one more container plus the headroom a prod/preview deploy
#   needs. If not, the PR is told so (topic-preview.yml comments "⏸ the server
#   is busy") and the job ends green — a full server is not a broken PR. Prod
#   and preview deploys check deploy_memory_verdict() before they touch the
#   schema, so a short box stops a deploy cleanly BEFORE the backup and the
#   push, never in the middle of a migration.
#
# KNOBS (environment; the defaults are the box's sizing on 2026-10-22)
#   TOPIC_MEMORY_MB       hard memory limit of one topic container   (1024)
#   TOPIC_HEADROOM_MB     kept free for prod/preview deploys          (2048)
#   TOPIC_MAX_ENVS        topic containers running at once, at most  (8)
#   DEPLOY_MIN_AVAILABLE_MB  a prod/preview deploy needs this free    (768; 0 = off)
#   MEMINFO_FILE          read instead of /proc/meminfo (tests)
#
# The verdict functions are pure (numbers in, one line out) and pinned by
# infra/test/capacity.test.sh; only the probes below touch the system.

TOPIC_MEMORY_MB="${TOPIC_MEMORY_MB:-1024}"
TOPIC_HEADROOM_MB="${TOPIC_HEADROOM_MB:-2048}"
TOPIC_MAX_ENVS="${TOPIC_MAX_ENVS:-8}"
DEPLOY_MIN_AVAILABLE_MB="${DEPLOY_MIN_AVAILABLE_MB:-768}"

# ── Probes ───────────────────────────────────────────────────────────────────

# MemAvailable in MB — the kernel's own estimate of what can be handed out
# without swapping (page cache counts as free here, unlike MemFree). Prints
# nothing when it cannot be read; callers treat that as "unknown → admit".
mem_available_mb() {
  awk '/^MemAvailable:/ { printf "%d\n", $2 / 1024; found = 1 } END { if (!found) exit 1 }' \
    "${MEMINFO_FILE:-/proc/meminfo}" 2>/dev/null
}

# Memory a running container uses now, in MB (0 when it is not running).
# `docker stats` prints e.g. "512.3MiB / 1GiB"; only the first figure matters.
container_mem_mb() { # container_mem_mb <name>
  local usage
  usage=$(docker stats --no-stream --format '{{.MemUsage}}' "$1" 2>/dev/null | head -1) || usage=''
  printf '%s\n' "${usage%% /*}" | awk '
    {
      v = $0 + 0
      if ($0 ~ /GiB|GB/) v *= 1024
      else if ($0 ~ /KiB|kB/) v /= 1024
      else if ($0 !~ /MiB|MB/) v /= 1048576   # plain bytes
      printf "%d\n", v
    }'
}

# Is <name> itself running? "1" or "0". A redeploy replaces it, so it never
# adds to the count of environments (topic_capacity_verdict's 4th argument).
container_running() { # container_running <name>
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qxF "$1"; then echo 1; else echo 0; fi
}

# Running topic containers (internship-crm-pr<N>) other than <name>.
topic_containers_except() { # topic_containers_except <name>
  # The grep pair matches nothing on an empty box; under `set -o pipefail` that
  # would be the function's status, so the count is taken in two steps.
  local names
  names=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E '^internship-crm-pr[0-9]+$' | grep -vxF "$1") || names=''
  if [ -z "$names" ]; then echo 0; else printf '%s\n' "$names" | wc -l | tr -d ' '; fi
}

# ── Verdicts (pure) ──────────────────────────────────────────────────────────

# May one more topic environment start? Prints "ok", or "deferred <reason>".
#   available  MemAvailable now, in MB ("" when unknown)
#   own        what this PR's current container uses (it is replaced, so its
#              memory comes back), in MB
#   others     topic containers running for OTHER PRs
#   replacing  1 when this PR's container is already running (a redeploy)
#
# The cap applies to NEW environments only. A redeploy replaces a container
# that is already counted, so refusing it lowers no count and frees no memory —
# it would only strand the PR on its old commit whenever the box is over the
# cap (e.g. right after TOPIC_MAX_ENVS is lowered). Memory still judges it.
topic_capacity_verdict() { # topic_capacity_verdict <available> <own> <others> [replacing]
  local available="$1" own="${2:-0}" others="${3:-0}" replacing="${4:-0}"
  if [ "$replacing" != 1 ] && [ "$others" -ge "$TOPIC_MAX_ENVS" ]; then
    echo "deferred ${others} topic environments are already running (the limit is ${TOPIC_MAX_ENVS})"
    return 0
  fi
  # An unreadable meminfo must not block every PR forever: the container's own
  # hard limit (TOPIC_MEMORY_MB) still caps the damage.
  [ -n "$available" ] || { echo ok; return 0; }
  local need=$((TOPIC_MEMORY_MB + TOPIC_HEADROOM_MB))
  local have=$((available + own))
  if [ "$have" -lt "$need" ]; then
    echo "deferred only ${have} MB of memory is free and a topic environment needs ${need} MB (${TOPIC_MEMORY_MB} MB for the container + ${TOPIC_HEADROOM_MB} MB kept free for production deploys)"
    return 0
  fi
  echo ok
}

# May a prod/preview deploy start its schema sync? Prints "ok", or
# "refused <reason>". DEPLOY_MIN_AVAILABLE_MB=0 turns the check off.
deploy_memory_verdict() { # deploy_memory_verdict <available>
  local available="$1"
  if [ "$DEPLOY_MIN_AVAILABLE_MB" -le 0 ] || [ -z "$available" ]; then echo ok; return 0; fi
  if [ "$available" -lt "$DEPLOY_MIN_AVAILABLE_MB" ]; then
    echo "refused only ${available} MB of memory is free and a deploy needs ${DEPLOY_MIN_AVAILABLE_MB} MB — stop some topic environments (docker ps --filter name=internship-crm-pr) or retry later"
    return 0
  fi
  echo ok
}
