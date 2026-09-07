#!/usr/bin/env bash
#
# CI-independent production deploy (#636).
#
# Does exactly what the `Production Deploy` job in .github/workflows/deploy.yml
# does — but runs ON THE SERVER (or over SSH from a laptop), so it needs no
# GitHub Actions minutes. Use it when the Actions quota is exhausted, or as the
# command a self-hosted runner / auto-deploy poller (infra/autodeploy.sh) calls.
#
# WHAT IT DOES
#   1. sync the working copy to origin/main (unless --no-pull)
#   2. obtain the image: either PULL a prebuilt one from ghcr (--pull-image, how
#      the deploy workflows do it since 2026-07-29 — the build runs on a
#      GitHub-hosted runner so this server never compiles) or build it locally
#      from source, stamping GIT_SHA
#   3. back up the database (infra/backup-db.sh), refuse a data-destroying
#      schema diff (infra/schema-guard.sh), then prisma db push
#      --accept-data-loss (schema sync, same as CI)
#   4. seed-templates + seed-goal-templates + backfill-project-members
#      + backfill-sso-plan (all idempotent)
#   5. swap the internship-crm container (host networking, port 3200, restart
#      unless-stopped) — byte-for-byte the flags deploy.yml uses. With
#      REPLICAS>1 the replicas are swapped ONE AT A TIME, each drained out of
#      the reverse-proxy pool first (#1701)
#   6. health-check http://127.0.0.1:3200 and prune old images
#
# SECRETS never live in the repo. They are read from an env file on the server
# (same values as the GitHub secrets): DATABASE_URL, NEXTAUTH_SECRET,
# NEXTAUTH_URL, SMTP_HOST/PORT/USER/PASS/FROM. Default path /etc/internship-crm/prod.env
# (override with ENV_FILE=...). Create it once, chmod 600.
#
# Every variable the app reads at runtime has to be listed in the `docker run`
# below — the env file is sourced here, not handed to the container. Adding a
# value to the file and forgetting the `-e` line is a silent no-op (that is how
# JAAS_* would have looked "configured" while video calls stayed on the public
# instance).
#
# USAGE
#   # on the server, from a checkout of the repo:
#   sudo ENV_FILE=/etc/internship-crm/prod.env ./infra/deploy-prod.sh
#
#   # or straight from your laptop over SSH:
#   ssh user@server 'cd /path/to/Internship && ENV_FILE=/etc/internship-crm/prod.env ./infra/deploy-prod.sh'
#
# FLAGS
#   --no-pull     deploy the current checkout as-is (skip git sync)
#   --skip-build  reuse the existing $IMAGE image, as-is (fast restart)
#   --pull-image  `docker pull $IMAGE` instead of building (implies --skip-build).
#                 For a private registry set GHCR_USER + GHCR_TOKEN and this
#                 logs in first; a public package needs neither.
#
# ENV OVERRIDES FOR THE DATA GATES (use knowingly)
#   FORCE_NO_BACKUP=1    deploy without taking a backup first
#   ALLOW_DESTRUCTIVE=1  apply a schema change that drops data (requires a backup)
#   BACKUP_DIR=...       where dumps go (default /var/backups/internship-crm)
#
# ENV
#   DEPLOY_SHA    the commit the image was built from. Only needed when the
#                 checkout can't be trusted to be that commit; defaults to HEAD.
#
# REPLICAS (#1701)
#   REPLICAS=1 (the default) is EXACTLY this script as it was: one container
#   named $CONTAINER on $PORT, one `docker stop`/`docker run`, no reverse-proxy
#   call at all. Nothing below behaves differently until somebody asks for a
#   second replica, which is the point — a deploy path is the worst place to
#   find out that a refactor changed something.
#
#   REPLICAS=2 runs two containers per environment and rolls the deploy through
#   them one at a time: drain replica 1 out of the proxy pool, swap it,
#   health-assert it, put it back, THEN touch replica 2. A failed health check
#   aborts with the other replica still serving the previous image, so a bad
#   release can never take both. Replica 1 keeps the historical name and port
#   (`internship-crm` on 3200) — everything else on the box addresses it that
#   way, from the env-file capture above to the drift gate's /api/health read,
#   and renaming it would be a second unrelated change riding along on a deploy.
#   Replica k>1 is `${CONTAINER}-k` on $PORT + (k-1)*REPLICA_PORT_STRIDE.
#
#   REPLICA_PORT_STRIDE  (default 10)  prod: 3200, 3210 — preview: 3201, 3211
#   DRAIN_TIMEOUT_S      (default 25)  SIGTERM grace before SIGKILL while
#                                      draining a replica (docker's own default
#                                      of 10 still applies at REPLICAS=1)
#   ROUTE_HOST           the hostname the proxy serves; defaults to the host in
#                        NEXTAUTH_URL
#   ROUTER / CADDY_*     passed through to infra/server/replica-route.sh
#
#   Going back to one replica is a deploy with REPLICAS=1 plus
#   `./infra/server/replica-route.sh --host <fqdn> --ports <port>`, which
#   rewrites the single-upstream site file bootstrap.sh generates. Then remove
#   the leftover container: `docker rm -f ${CONTAINER}-2`.
#
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/internship-crm/prod.env}"
CONTAINER="${CONTAINER:-internship-crm}"
PORT="${PORT:-3200}"
IMAGE="${IMAGE:-internship-crm:local}"
REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
BRANCH="${BRANCH:-main}"

NO_PULL=0
SKIP_BUILD=0
PULL_IMAGE=0
ROLLBACK=0
for arg in "$@"; do
  case "$arg" in
    --no-pull) NO_PULL=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    # The image already exists in the registry — fetching it replaces the build.
    --pull-image) PULL_IMAGE=1; SKIP_BUILD=1 ;;
    # Put the previous release back (#961). No git, no build, no schema push —
    # the one thing you need working when a deploy has just gone wrong.
    --rollback) ROLLBACK=1 ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }

cd "$REPO_DIR"

# ── 0. Preconditions ────────────────────────────────────────────────────────
command -v docker >/dev/null || { echo "ERROR: docker not found on PATH" >&2; exit 1; }
# If the env file is missing but the production container is already running,
# derive the env from it (#636) — the values never leave the server and no
# secret ever has to be typed by hand. Only the first deploy on a fresh box
# needs the file created manually.
if [ ! -f "$ENV_FILE" ] && docker inspect "$CONTAINER" >/dev/null 2>&1; then
  log "env file missing — capturing it from the running $CONTAINER container"
  mkdir -p "$(dirname "$ENV_FILE")"
  : > "$ENV_FILE"; chmod 600 "$ENV_FILE"
  for k in DATABASE_URL NEXTAUTH_SECRET NEXTAUTH_URL SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_FROM \
           SMTP_BULK_HOST SMTP_BULK_PORT SMTP_BULK_USER SMTP_BULK_PASS SMTP_BULK_FROM \
           INBOUND_EMAIL_DOMAIN INBOUND_SECRET INBOUND_IMAP_HOST INBOUND_IMAP_PORT INBOUND_IMAP_USER \
           INBOUND_IMAP_PASS INBOUND_IMAP_MAILBOX INBOUND_IMAP_POLL_SECONDS INBOUND_IMAP_ENABLED \
           CRON_SECRET CRON_ENABLED JAAS_APP_ID JAAS_API_KEY_ID JAAS_PRIVATE_KEY; do
    v=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER" | sed -n "s/^$k=//p" | head -1)
    # Single-quote the value so `. "$ENV_FILE"` sources it verbatim — a
    # DATABASE_URL/password can contain characters ($, spaces, @, :) that the
    # shell would otherwise try to expand or execute. Embedded single quotes are
    # escaped the standard '\'' way.
    [ -n "$v" ] && printf "%s='%s'\n" "$k" "$(printf '%s' "$v" | sed "s/'/'\\\\''/g")" >> "$ENV_FILE"
  done
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: env file not found: $ENV_FILE (and no running $CONTAINER to derive it from)" >&2
  echo "Create it (chmod 600) with the production secrets — see the header of this script." >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
: "${DATABASE_URL:?DATABASE_URL missing in $ENV_FILE}"
: "${NEXTAUTH_SECRET:?NEXTAUTH_SECRET missing in $ENV_FILE}"
: "${NEXTAUTH_URL:?NEXTAUTH_URL missing in $ENV_FILE}"

# ── Runtime shape: networking, health checks, image hygiene ──────────────────
# Defined up here, before anything touches git or the registry, because the
# rollback path below has to work when those are exactly what is broken (#961).
STATE_FILE="${DEPLOY_STATE_FILE:-$(dirname "$ENV_FILE")/.${CONTAINER}.deployed-sha}"

# Emit a warning that is actually visible in the Actions UI, not just buried in a
# green job log. A refused or skipped prod deploy used to be indistinguishable
# from a successful one.
warn() {
  log "WARNING: $*"
  # GitHub Actions workflow command (no-op outside CI).
  printf '::warning::%s\n' "$*"
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] && printf '### ⚠️ %s\n' "$*" >> "$GITHUB_STEP_SUMMARY"
  return 0
}

# The forward-only baseline: prefer what the container actually reports at
# /api/health over the state file. The file is only written by THIS script, so a
# deploy from any other path (the legacy deploy.yml over SSH, a manual
# `docker run`) leaves it stale and the guard then reasons about a commit that
# has not been live for weeks.
# The detailed fields (incl. sha) are gated on HEALTH_TOKEN when it is set
# (#897); sending it here keeps the drift gate working once it is configured.
# Kept as a plain string, not an array: `set -u` plus an empty array is a
# portability trap in bash < 4.4, and this runs on whatever the box ships.
HEALTH_HDR=""
[ -n "${HEALTH_TOKEN:-}" ] && HEALTH_HDR="X-Health-Token: ${HEALTH_TOKEN}"
health_curl() { # health_curl <url>
  if [ -n "$HEALTH_HDR" ]; then curl -fsS --max-time 10 -H "$HEALTH_HDR" "$1"; else curl -fsS --max-time 10 "$1"; fi
}

# Networking mode (#preview): prod runs on host networking with the DB at
# localhost. Preview's DB user is only granted from the docker gateway (not
# localhost), so preview must use bridge networking + host.docker.internal and
# a published port. Default 'host' keeps prod behavior byte-for-byte.
NETWORK="${NETWORK:-host}"
if [ "$NETWORK" = host ]; then
  TOOL_NET_ARGS=(--network=host)
else
  TOOL_NET_ARGS=(--add-host=host.docker.internal:host-gateway)
fi

# --- Replicas (#1701) -------------------------------------------------------
# One number decides the shape of everything below. At 1 this section
# contributes a single container on a single port and no proxy call at all,
# which is the behaviour this script has always had.
REPLICAS="${REPLICAS:-1}"
case "$REPLICAS" in
  ''|*[!0-9]*|0) echo "ERROR: REPLICAS must be a positive integer (got '$REPLICAS')" >&2; exit 2 ;;
esac
REPLICA_PORT_STRIDE="${REPLICA_PORT_STRIDE:-10}"
DRAIN_TIMEOUT_S="${DRAIN_TIMEOUT_S:-25}"
# The hostname the reverse proxy serves. Derived from NEXTAUTH_URL rather than
# hardcoded so preview and prod need no extra configuration.
ROUTE_HOST="${ROUTE_HOST:-$(printf '%s' "${NEXTAUTH_URL:-}" | sed -E 's#^[a-zA-Z]+://##; s#/.*$##; s#:[0-9]+$##')}"

# Replica 1 IS the historical container: same name, same port.
replica_container() { # replica_container <index>
  if [ "$1" = 1 ]; then printf '%s' "$CONTAINER"; else printf '%s-%s' "$CONTAINER" "$1"; fi
}
replica_port() { # replica_port <index>
  printf '%s' "$(( PORT + (($1 - 1) * REPLICA_PORT_STRIDE) ))"
}

# The docker flags that differ per replica: the network mode and where the app
# listens. For replica 1 this emits byte-for-byte the pair of arrays this script
# used before REPLICAS existed (`--network=host -e PORT=3200`, or
# `--add-host=... -p 3200:3000` on bridge networking).
replica_net_args() { # replica_net_args <port>
  if [ "$NETWORK" = host ]; then
    printf '%s\0' --network=host -e PORT="$1"
  else
    # bridge: reach the host DB via host.docker.internal, publish the app port.
    printf '%s\0' --add-host=host.docker.internal:host-gateway -p "$1:3000"
  fi
}

# The interim scheduler guard (#1701, removed by #1676).
#
# The IMAP bridge is protected by a real lease: every replica polls and the ones
# that do not hold `'imap-bridge'` quietly do nothing. The in-process CRON is
# not, yet — its schedules are registered once at boot by
# src/instrumentation.ts, so a lease taken at registration would be held by
# whoever booted first and never renewed. Making each scheduled tick take the
# `'scheduler'` lease needs the schedule registry, which is #1676's job.
#
# Until then the second replica runs with CRON_ENABLED=0 — the documented kill
# switch, exactly as the canary already uses it, and NOT a second election
# mechanism. The cost is honest and worth writing down: the scheduler is pinned
# to replica 1, so while replica 1 is down (or mid-swap) reminders wait rather
# than being sent by replica 2. Waiting is recoverable; sending every reminder
# twice is not.
replica_extra_env() { # replica_extra_env <index>
  if [ "$1" = 1 ]; then
    printf ''
  else
    printf '%s\0' -e CRON_ENABLED=0
  fi
}

# Which replicas are actually up, as a port list — the pool the proxy should
# hold right now. Asking docker rather than assuming is what makes the FIRST
# two-replica deploy safe: replica 2 does not exist yet, so nothing is routed to
# it until it has passed a health check.
running_pool() {
  local i=1 out="" name
  while [ "$i" -le "$REPLICAS" ]; do
    name="$(replica_container "$i")"
    if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || echo false)" = true ]; then
      out="${out}$(replica_port "$i") "
    fi
    i=$((i + 1))
  done
  # Never hand the proxy an empty pool: an environment with nothing running is
  # a 502 either way, and a site block with no upstream does not even validate.
  [ -n "$out" ] || out="$(replica_port 1)"
  printf '%s' "${out% }"
}

pool_without() { # pool_without <port> — the running pool minus one replica
  local keep="" p
  for p in $(running_pool); do
    [ "$p" = "$1" ] || keep="${keep}${p} "
  done
  printf '%s' "${keep% }"
}

# Point the proxy at a set of ports. A no-op at REPLICAS=1: a single-container
# environment is routed by bootstrap.sh, and this script must not touch a vhost
# it does not own.
route_pool() { # route_pool <ports>
  [ "$REPLICAS" -gt 1 ] || return 0
  local ports="$1"
  if [ -z "$ports" ]; then
    warn "refusing to hand the proxy an empty upstream pool — leaving the routing as it is"
    return 0
  fi
  if [ -z "$ROUTE_HOST" ]; then
    echo "ERROR: cannot route replicas — ROUTE_HOST is empty and NEXTAUTH_URL gave no host." >&2
    return 1
  fi
  "$REPO_DIR/infra/server/replica-route.sh" --host "$ROUTE_HOST" --ports "$ports"
}

run_tool() { # run a one-off tool container against the DB (network per $NETWORK)
  docker run --rm "${TOOL_NET_ARGS[@]}" -e DATABASE_URL="$DATABASE_URL" "$IMAGE" "$@"
}

# One list of runtime env flags, used for BOTH containers. Two copies of this
# list is how a variable ends up set on the canary and missing in production.
app_env_args() {
  printf '%s\0' \
    -e DATABASE_URL="$DATABASE_URL" \
    -e NEXTAUTH_SECRET="$NEXTAUTH_SECRET" \
    -e NEXTAUTH_URL="$NEXTAUTH_URL" \
    -e NEXT_PUBLIC_APP_URL="$NEXTAUTH_URL" \
    -e SMTP_HOST="${SMTP_HOST:-}" \
    -e SMTP_PORT="${SMTP_PORT:-}" \
    -e SMTP_USER="${SMTP_USER:-}" \
    -e SMTP_PASS="${SMTP_PASS:-}" \
    -e SMTP_FROM="${SMTP_FROM:-}" \
    -e SMTP_BULK_HOST="${SMTP_BULK_HOST:-}" \
    -e SMTP_BULK_PORT="${SMTP_BULK_PORT:-}" \
    -e SMTP_BULK_USER="${SMTP_BULK_USER:-}" \
    -e SMTP_BULK_PASS="${SMTP_BULK_PASS:-}" \
    -e SMTP_BULK_FROM="${SMTP_BULK_FROM:-}" \
    -e INBOUND_EMAIL_DOMAIN="${INBOUND_EMAIL_DOMAIN:-}" \
    -e INBOUND_SECRET="${INBOUND_SECRET:-}" \
    -e INBOUND_IMAP_HOST="${INBOUND_IMAP_HOST:-}" \
    -e INBOUND_IMAP_PORT="${INBOUND_IMAP_PORT:-}" \
    -e INBOUND_IMAP_USER="${INBOUND_IMAP_USER:-}" \
    -e INBOUND_IMAP_PASS="${INBOUND_IMAP_PASS:-}" \
    -e INBOUND_IMAP_MAILBOX="${INBOUND_IMAP_MAILBOX:-}" \
    -e INBOUND_IMAP_POLL_SECONDS="${INBOUND_IMAP_POLL_SECONDS:-}" \
    -e INBOUND_IMAP_ENABLED="${INBOUND_IMAP_ENABLED:-}" \
    -e CRON_SECRET="${CRON_SECRET:-}" \
    -e CRON_ENABLED="${CRON_ENABLED:-}" \
    -e TRUSTED_PROXY_COUNT="${TRUSTED_PROXY_COUNT:-1}" \
    -e HEALTH_TOKEN="${HEALTH_TOKEN:-}" \
    -e JAAS_APP_ID="${JAAS_APP_ID:-}" \
    -e JAAS_API_KEY_ID="${JAAS_API_KEY_ID:-}" \
    -e JAAS_PRIVATE_KEY="${JAAS_PRIVATE_KEY:-}" \
    -e VAPID_PUBLIC_KEY="${VAPID_PUBLIC_KEY:-}" \
    -e VAPID_PRIVATE_KEY="${VAPID_PRIVATE_KEY:-}" \
    -e VAPID_SUBJECT="${VAPID_SUBJECT:-}" \
    -e OPERATOR_NAME="${OPERATOR_NAME:-}" \
    -e OPERATOR_ADDRESS="${OPERATOR_ADDRESS:-}" \
    -e OPERATOR_EMAIL="${OPERATOR_EMAIL:-}" \
    -e OPERATOR_PHONE="${OPERATOR_PHONE:-}" \
    -e OPERATOR_RESPONSIBLE="${OPERATOR_RESPONSIBLE:-}" \
    -e OPERATOR_VAT_ID="${OPERATOR_VAT_ID:-}" \
    -e OPERATOR_REGISTER="${OPERATOR_REGISTER:-}" \
    -e OPERATOR_DPO="${OPERATOR_DPO:-}"
}
# OPERATOR_* (#1396) publishes /imprint and names the GDPR controller on
# /privacy. They live in the env file rather than the source because the project
# is AGPL and other people run their own instances. This forwarding line is the
# whole feature on a deployed host: unset here, the container would keep saying
# "no imprint published" no matter what the env file holds.
mapfile -d '' -t APP_ENV_ARGS < <(app_env_args)

# Wait for /api/health?db=1 and assert what it says. Used for the canary, for
# the real container, and for --rollback.
#   check_health <url> <container> [expected-sha|any]
check_health() {
  local url="$1" name="$2" want_sha="${3:-any}" health='' i
  for i in $(seq 1 30); do
    health="$(health_curl "$url" 2>/dev/null || true)"
    [ -n "$health" ] && break
    sleep 2
  done
  if [ -z "$health" ]; then
    echo "ERROR: $name did not answer at $url within 60s. Recent logs:" >&2
    docker logs --tail 40 "$name" >&2 || true
    return 1
  fi
  local field status sha db
  field() { printf '%s' "$health" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"; }
  status="$(field status)"; sha="$(field sha)"; db="$(field db)"
  if [ "$db" = error ]; then
    echo "ERROR: $name is up but cannot reach the database (health: $health)." >&2
    docker logs --tail 40 "$name" >&2 || true
    return 1
  fi
  if [ "$status" != ok ]; then
    echo "ERROR: $name reported status '$status' (health: $health)." >&2
    return 1
  fi
  # GIT_SHA is baked into the image at build time and truncated to 7 in
  # src/lib/version.ts. 'dev' means the --build-arg was lost, which would also
  # make the drift gate rebuild on every tick forever — a failure, not drift.
  if [ "$want_sha" != any ] && [ "$sha" != "$want_sha" ]; then
    echo "ERROR: $name is serving sha '$sha' but $want_sha was just built and deployed." >&2
    echo "       A stale image would be live and the drift gate would treat it as current." >&2
    docker logs --tail 40 "$name" >&2 || true
    return 1
  fi
  SERVED_SHA="$sha"; SERVED_DB="$db"; SERVED_STATUS="$status"
  return 0
}

# Reclaim disk WITHOUT deleting the rollback target. `docker image prune -af`
# removes every image no container is using — including the `:previous` tag this
# script just created, which would quietly undo the whole point of #961. So:
# dangling layers unconditionally, plus app images that are neither the one
# running nor the one we can roll back to.
prune_images() {
  local keep_current="$1" keep_prev="$2"
  docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \
    | grep -E '^(ghcr\.io/[^:]+|internship-crm[^:]*):' \
    | grep -vx "$keep_current" \
    | grep -vx "$keep_prev" \
    | grep -v ':previous$' \
    | xargs -r docker rmi >/dev/null 2>&1 || true
  docker image prune -f >/dev/null 2>&1 || true
  docker builder prune -af --filter until=72h >/dev/null 2>&1 || true
}

remove_canary() {
  docker stop "$CANARY" >/dev/null 2>&1 || true
  docker rm   "$CANARY" >/dev/null 2>&1 || true
}


# ── Rollback (#961) ──────────────────────────────────────────────────────────
# Deliberately BEFORE the git sync, the build and the schema push: when a deploy
# has just gone wrong, the last thing you want is for putting the old release
# back to depend on the machinery that broke. This path touches nothing but
# docker.
if [ "$ROLLBACK" = "1" ]; then
  PREV_TAG="${CONTAINER}:previous"
  docker image inspect "$PREV_TAG" >/dev/null 2>&1 || {
    echo "ERROR: no rollback target — $PREV_TAG does not exist on this host." >&2
    echo "       It is created by the deploy that replaced the previous release; an" >&2
    echo "       environment that has not deployed since #961 shipped has none yet." >&2
    exit 1
  }
  # Every replica goes back, one at a time and in the same order as a forward
  # deploy. NOT rolled through the proxy pool: a rollback is what you run when
  # the release is already broken, so the fastest possible path back to the
  # previous image beats a graceful one — and at REPLICAS=1 this is the single
  # container it always was.
  ROLLBACK_INDEX=1
  while [ "$ROLLBACK_INDEX" -le "$REPLICAS" ]; do
    RB_NAME="$(replica_container "$ROLLBACK_INDEX")"
    RB_PORT="$(replica_port "$ROLLBACK_INDEX")"
    mapfile -d '' -t RB_NET_ARGS < <(replica_net_args "$RB_PORT")
    RB_EXTRA_ENV=()
    mapfile -d '' -t RB_EXTRA_ENV < <(replica_extra_env "$ROLLBACK_INDEX")
    log "Rolling $RB_NAME back to $PREV_TAG on :$RB_PORT"
    docker stop "$RB_NAME" 2>/dev/null || true
    docker rm   "$RB_NAME" 2>/dev/null || true
    docker run -d \
      --name "$RB_NAME" \
      "${RB_NET_ARGS[@]}" \
      --restart=unless-stopped \
      "${APP_ENV_ARGS[@]}" \
      ${RB_EXTRA_ENV[@]+"${RB_EXTRA_ENV[@]}"} \
      -e REPLICA_ID="$RB_NAME" \
      "$PREV_TAG" >/dev/null
    # No sha to assert against: the point of a rollback is that we want whatever
    # the previous image serves. Report it so the operator can see where they are.
    if ! check_health "http://127.0.0.1:$RB_PORT/api/health?db=1" "$RB_NAME" any; then
      echo "ERROR: the rollback target is ALSO unhealthy on $RB_NAME. This host needs hands." >&2
      exit 1
    fi
    ROLLBACK_INDEX=$((ROLLBACK_INDEX + 1))
  done
  if [ "$REPLICAS" -gt 1 ]; then
    route_pool "$(running_pool)" || warn "rolled back, but the proxy pool could not be rewritten — check the routing by hand"
  fi
  
  # The state file drives the forward-only guard. A rollback is a deliberate
  # move backwards, so record what is actually live — otherwise the next deploy
  # compares against a commit that is no longer serving.
  mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true
  printf '%s\n' "$SERVED_SHA" > "$STATE_FILE" 2>/dev/null || true
  log "Rolled back — ${REPLICAS} replica(s) up from :$PORT serving ${SERVED_SHA}, db ${SERVED_DB:-skipped}"
  exit 0
fi

# ── 1. Sync source ───────────────────────────────────────────────────────────
if [ "$NO_PULL" -eq 0 ]; then
  log "Syncing $BRANCH from origin"
  git fetch origin "$BRANCH"
  git checkout "$BRANCH"
  git reset --hard "origin/$BRANCH"
fi
# DEPLOY_SHA lets the caller name the commit the image was built from, which is
# what the forward-only guard and the state file below must reason about. With a
# local build that is always HEAD; with --pull-image the workflow passes the sha
# it built so a shared/shallow runner workspace can't disagree with the image.
GIT_SHA="${DEPLOY_SHA:-$(git rev-parse HEAD)}"
log "Deploying ${GIT_SHA:0:7} — $(node -p "require('./package.json').version" 2>/dev/null || echo '?')"

# ── 1b. Forward-only guard (prod) ────────────────────────────────────────────
# Production must only ever move FORWARD. Two uncoordinated deployers write the
# prod container (the cron autodeploy poller + the deploy-prod workflow), and a
# stale/out-of-order build could otherwise overwrite a newer release with an
# older commit (the "one step forward, one step back" regressions). When
# FORWARD_ONLY=1, refuse to deploy a commit that is an ancestor of (i.e. older
# than) the last one this container successfully deployed. Preview/topic deploys
# leave FORWARD_ONLY unset so they can still deploy arbitrary/older PR refs.
# Set FORCE=1 for a deliberate rollback.

LIVE_SHA="$(health_curl "http://127.0.0.1:$PORT/api/health" 2>/dev/null \
            | sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' || true)"
if [ "${FORWARD_ONLY:-0}" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  LAST_SHA="$LIVE_SHA"
  if [ -z "$LAST_SHA" ] && [ -f "$STATE_FILE" ]; then
    LAST_SHA="$(cat "$STATE_FILE" 2>/dev/null || true)"
  fi
  if [ -n "$LAST_SHA" ] && [ "${LAST_SHA:0:7}" != "${GIT_SHA:0:7}" ] && [ "$LAST_SHA" != dev ]; then
    # The ancestry questions below need real history. actions/checkout defaults
    # to fetch-depth 1, and on a shallow clone `cat-file`/`merge-base` fail —
    # which used to make the whole guard fail OPEN, silently allowing exactly
    # the regression it exists to prevent. Deepen before asking.
    if ! git cat-file -e "${LAST_SHA}^{commit}" 2>/dev/null; then
      git fetch --quiet --unshallow origin 2>/dev/null \
        || git fetch --quiet --deepen=500 origin 2>/dev/null || true
    fi
    if ! git cat-file -e "${LAST_SHA}^{commit}" 2>/dev/null; then
      # Fail CLOSED: we cannot prove this is a forward move, so refuse loudly
      # rather than deploy and hope. FORCE=1 is the deliberate override.
      warn "$CONTAINER: cannot resolve the live commit ${LAST_SHA:0:7} in this clone, so a forward-only check is impossible. Refusing to deploy ${GIT_SHA:0:7} (set FORCE=1 to override)."
      exit 1
    fi
    if git merge-base --is-ancestor "$GIT_SHA" "$LAST_SHA" 2>/dev/null; then
      warn "$CONTAINER: refusing to regress — ${GIT_SHA:0:7} is OLDER than the live commit ${LAST_SHA:0:7} (set FORCE=1 to roll back deliberately)."
      exit 0
    fi
    if ! git merge-base --is-ancestor "$LAST_SHA" "$GIT_SHA" 2>/dev/null; then
      # Neither an ancestor nor a descendant: the live container is on a commit
      # that is not on this branch at all (e.g. a dispatch of a feature branch).
      # Left alone this deadlocks — the drift gate wants to deploy, this guard
      # refuses, and every 6-hourly run reports SUCCESS while prod stays off
      # main forever. Deploying forward is correct here; just make it visible.
      warn "$CONTAINER: live commit ${LAST_SHA:0:7} is not an ancestor of ${GIT_SHA:0:7} — prod was off-branch. Deploying forward onto ${GIT_SHA:0:7}."
    fi
  fi
fi

# ── 2. Obtain the image: pull a prebuilt one, or build from source ───────────
# Pulling is the normal path now — the deploy workflows build on a GitHub-hosted
# runner and push to ghcr, so this box does no compiling. Building locally
# remains supported for a manual/offline deploy from a shell on the server.
if [ "$PULL_IMAGE" -eq 1 ]; then
  log "Pulling $IMAGE"
  if [ -n "${GHCR_TOKEN:-}" ]; then
    printf '%s' "$GHCR_TOKEN" \
      | docker login ghcr.io -u "${GHCR_USER:-github-actions}" --password-stdin
  fi
  docker pull "$IMAGE"
elif [ "$SKIP_BUILD" -eq 0 ]; then
  log "Building $IMAGE (GIT_SHA=$GIT_SHA)"
  docker build --build-arg GIT_SHA="$GIT_SHA" -t "$IMAGE" .
fi

# ── 3. Backup, then schema sync ──────────────────────────────────────────────
# The push below runs with --accept-data-loss, so this is the last moment at
# which the current database still exists in full. Both steps are gates, not
# niceties: no backup → no deploy, and a data-destroying diff → no deploy
# without an explicit operator decision (#1179).
# This same script deploys prod, the shared preview and every topic env — the
# caller only overrides CONTAINER. The gates scale with what is at stake:
#   prod     → back up (REQUIRED — a failed dump stops the deploy), and REFUSE
#              a data-destroying diff
#   preview  → try to back up but only WARN on failure, and only WARN on a
#              destructive diff (schema experiments belong there)
#   topic    → neither; those envs are disposable and share the preview DB,
#              so a dump per PR deploy is noise, not safety
#
# Preview's backup became advisory in #1200. It is the same tiering the schema
# guard already uses one block down, applied to the other gate: preview's DB
# user is granted from the docker gateway only, so a dump taken on the host
# authenticates as the server's public IP and is refused (error 1045). Until
# that grant exists, a hard gate there blocks every preview deploy to protect a
# database whose whole purpose is to be disposable — while prod, which is what
# the gate was actually built for (#1179), keeps its guarantee unchanged.
case "$CONTAINER" in
  internship-crm) ENV_LABEL=prod ;;
  internship-crm-preview) ENV_LABEL=preview ;;
  *) ENV_LABEL="${CONTAINER#internship-crm-}" ;;
esac

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_TAKEN=0
if [ "$ENV_LABEL" != "prod" ] && [ "$ENV_LABEL" != "preview" ]; then
  log "Disposable env ($ENV_LABEL) — skipping backup and running the schema guard in warn-only mode"
elif [ "${FORCE_NO_BACKUP:-0}" = "1" ]; then
  log "!! FORCE_NO_BACKUP=1 — DEPLOYING WITHOUT A BACKUP (operator override)"
else
  log "Backing up the database before the schema sync"
  # Runs on the host (mysqldump), not in the image: the dump must survive even
  # if the new image is broken, and it must never live inside a container layer.
  #
  # Which is why the URL needs rewriting first (#1200). Under bridge networking
  # $DATABASE_URL names the DB as `host.docker.internal` — a name that exists
  # ONLY inside a container started with --add-host. On the host it does not
  # resolve, so preview's backup died with "Unknown server host" on every deploy.
  #
  # The docker gateway (172.17.0.1) was the first attempt and it connects, but
  # MariaDB attributes the connection to the box's PUBLIC ip, and `crm-preview`
  # is granted from `172.17.%` only — error 1045. So use loopback and mirror what
  # prod has always done: `crm` is granted @localhost and dumps fine that way.
  # `crm-preview`@localhost now exists too, deliberately READ-ONLY and scoped to
  # internship_crm_preview (the 172.17.% entry keeps the full DDL rights the app
  # needs). Verified on the server: 60 tables, 7.5MB.
  #
  # Loopback rather than the public ip on purpose — it does not change when the
  # box is renumbered, and it is the one address a local dump can always reach.
  BACKUP_DATABASE_URL="$DATABASE_URL"
  if [ "$NETWORK" != host ]; then
    BACKUP_DATABASE_URL="${DATABASE_URL//host.docker.internal/127.0.0.1}"
    log "Backup reaches the DB over loopback (the container's host alias is not resolvable here)"
  fi
  # On prod a failed dump stops the deploy; on preview it is reported and the
  # deploy continues (see the tiering note above). BACKUP_TAKEN stays 0 in that
  # case, which is what keeps ALLOW_DESTRUCTIVE unusable there — a preview whose
  # backup failed still cannot be talked into a data-destroying schema push.
  if DATABASE_URL="$BACKUP_DATABASE_URL" \
     BACKUP_DIR="${BACKUP_DIR:-/var/backups/internship-crm}" \
       "$REPO_DIR/infra/backup-db.sh" --env "$ENV_LABEL" --stamp "$STAMP"; then
    BACKUP_TAKEN=1
  elif [ "$ENV_LABEL" = "prod" ]; then
    log "Backup FAILED on prod — refusing to deploy. Fix the dump, or set
FORCE_NO_BACKUP=1 as a deliberate one-off override."
    exit 1
  else
    warn "Backup FAILED on $ENV_LABEL — deploying anyway without a fresh dump (advisory on this env, see #1200)"
  fi
fi

log "Checking the pending schema change for data loss"
GUARD_ARGS=()
[ "$ENV_LABEL" = "prod" ] || GUARD_ARGS=(--warn-only)
RUN_TOOL="docker run --rm ${TOOL_NET_ARGS[*]} -e DATABASE_URL=$DATABASE_URL $IMAGE npx" \
  BACKUP_TAKEN="$BACKUP_TAKEN" \
  "$REPO_DIR/infra/schema-guard.sh" "${GUARD_ARGS[@]+"${GUARD_ARGS[@]}"}"

log "prisma db push (CompanyInterest FK-index expand phase)"
run_tool node prisma/push-company-interest-expand.mjs

log "backfill CompanyInterest deterministic scope keys"
run_tool node prisma/backfill-company-interest-scope.mjs

log "prisma db push (Setting.id surrogate-key expand phase)"
run_tool node prisma/push-setting-id-expand.mjs

log "backfill Setting surrogate ids"
run_tool node prisma/backfill-setting-id.mjs

# ALSO before the push, not only after (#1288): when a previous half-applied
# push has left a Json column filled with '' (the MariaDB longtext fill, see
# the note below), the NEXT push can die before the post-push repair ever
# runs — any step that rebuilds the table (AddForeignKey, index changes)
# re-validates the json_valid() CHECK against the poisoned rows. That is
# exactly how MentorshipRequest.preferredLanguages wedged the 2026-08-24 prod
# deploy: the '' fill from the failed run's AddColumn step made every retry
# fail at the AddForeignKey step. Repairing first makes the push re-runnable.
log "repair invalid Json column values (pre-push, idempotent)"
run_tool node prisma/backfill-json-columns.mjs --repair || true

log "prisma db push (final contract phase)"
run_tool npx prisma db push --accept-data-loss

# Immediately after the push, because the push itself is what breaks these
# (#1150). Prisma DROPS `@default` when it emits DDL for a `Json` field, so a
# new one becomes a bare `ALTER TABLE ... ADD COLUMN x JSON NOT NULL`; on
# MariaDB — which prod is, and where `JSON` is only an alias for
# `LONGTEXT utf8mb4_bin` — that backfills every PRE-EXISTING row with the empty
# string, silently, even under STRICT_TRANS_TABLES. Prisma then JSON.parse()s
# the column on read, so every one of those rows becomes unreadable: adding
# `User.languages` (#1078) locked every account that predated the deploy out of
# sign-in with "Unexpected end of JSON input". This resets values that are
# already unreadable to the schema default — inert garbage in, valid JSON out,
# never a value the app could have used. Converges to a no-op.
log "repair invalid Json column values (idempotent)"
run_tool node prisma/backfill-json-columns.mjs --repair || true

# ── 4. Idempotent seeds / backfills ──────────────────────────────────────────
log "seed-templates + project-member backfill (idempotent)"
run_tool node prisma/seed-templates.mjs || true
# The shared project-goal template pool (#51) — every project sees these on top
# of its own. Only ever adds missing titles.
run_tool node prisma/seed-goal-templates.mjs || true
# Contributor terms v1.0 (#1025) — versioned rows; never edits an existing one.
run_tool node prisma/seed-contributor-terms.mjs || true
run_tool node prisma/backfill-project-members.mjs || true
# Tenant backfill (#1557): the script now exits non-zero when a nullable orgId
# column still holds NULLs after its retry passes. `|| true` stays for now — a
# deploy must not abort on it, and #1540 is replacing this whole `|| true`
# pattern with a backfill registry — but the failure is announced instead of
# swallowed, because an incomplete backfill is the one thing that must block
# MT_ENFORCE_ISOLATION. The warning describes the exit code, not the database:
# the script also exits non-zero when the DB is unreachable or the run never
# got as far as counting anything.
run_tool node prisma/backfill-organization.mjs \
  || log "WARNING: org backfill FAILED (exit non-zero) — see the output above. It may be incomplete; do NOT enable MT_ENFORCE_ISOLATION until it runs green (#1557)."
run_tool node scripts/backfill-requisitions.mjs || true
# Detector, NOT a gate (#419): reports mentees holding more than one ACTIVE
# mentorship. Exits 0 by design, and `|| true` on top — this must never be the
# reason a deploy fails. The DB-level @@unique([activeMenteeKey]) backstop lands
# only once this reads clean on prod AND on the shared preview, because
# `prisma db push --accept-data-loss` would fail on it otherwise.
log "check for mentees with more than one active mentor (report only)"
run_tool node prisma/check-active-mentor-duplicates.mjs || true
# API key lifecycle (#1545) + tenant anchor (#1466): give legacy keys the
# default org and the 'candidates:read' scope they already had in practice.
# Must run AFTER backfill-organization.mjs, which creates the default org.
run_tool node prisma/backfill-api-key-lifecycle.mjs || true
# One-shot: baseline the scheduled-job backlog so the first cron tick doesn't
# email out history. Self-skips once applied (Setting 'cronBaselineAt').
run_tool node prisma/backfill-cron-baseline.mjs || true
# Stamp completedAt on relations that were COMPLETED before the column existed,
# so the post-mentorship CV access window (#854) has an anchor instead of
# revoking access outright. Only ever fills NULLs — idempotent.
run_tool node prisma/backfill-relation-completed-at.mjs || true
# Remove the Meeting rows the old recurring-meeting generator materialised. A
# series is a rule now; those rows outlived their cancelled series and haunted
# the calendar (#1110). Nothing writes them any more, so this converges to a
# no-op on the next deploy.
run_tool node prisma/backfill-series-meetings.mjs || true
# Grandfather tenants whose SAML SSO was live BEFORE it became a paid feature
# (#1742). plan defaults to FREE, so the new entitlement in isSsoActive() would
# otherwise take them offline on this very deploy — and their users are
# provisioned with no usable password, so there is no fallback to sign in with.
# Converges to a no-op once every such tenant sits on ENTERPRISE.
run_tool node prisma/backfill-sso-plan.mjs || true

# Move pre-#1806 review notes out of MentorApplication.rejectReason into the
# new adminNote column — non-rejected rows only, where the value can only be a
# note. Only ever fills NULLs — idempotent.
run_tool node prisma/backfill-mentor-application-admin-note.mjs || true

# Move relations that were created on the schema default (APPLICATION_100) in a
# tenant whose custom stage set does not contain that key (#1634). They render
# in no board column and count in no funnel row; each move writes a StatusChange
# so it is auditable.
#
# It moves ONLY rows that can just be the bug: still on APPLICATION_100, still
# ACTIVE, and never moved (zero StatusChange rows). It deliberately does NOT
# repair every relation whose key is outside the org's current set — renaming a
# stage in the editor puts a tenant's whole in-flight pipeline in that state for
# a moment, and sweeping it would drag placed and completed mentees back to
# stage 1 unattended. The script is dry-run by default; `--apply` is this line's
# deliberate choice. Converges to a no-op after the first deploy.
run_tool node prisma/backfill-relation-start-stage.mjs --apply || true

# Give every Organization a Subscription row matching the plan it already had
# (#1731). The commercial state moved from the `Organization.plan` enum to its
# own table on this deploy; an org without a row would be read as the free tier.
# Creates only what is missing and never edits an existing subscription, so it
# converges to a no-op — and the app's own getOrCreateSubscription() covers any
# org created after this ran.
run_tool node prisma/backfill-org-subscription.mjs || true

# ── 5. Swap the container ────────────────────────────────────────────────────
# Blue/green, because the old way was an outage waiting to happen (#961): it
# stopped and removed the running container BEFORE proving the new image works,
# so any failure between `docker stop` and a passing health check left the
# environment DOWN rather than merely stale — and on 2026-07-28 it did exactly
# that, on all three environments at once.
#
# Now: start the new image under a throwaway name on a throwaway port, prove it
# boots, reaches the database and serves the sha we just built, and only then
# touch the thing that is currently serving. If the canary fails, the old
# container is still running and this script exits non-zero having changed
# nothing about what users see.
#
# Host networking means the canary cannot share $PORT, so it gets its own — the
# canary proves the IMAGE, and the final swap is then a restart on the real
# port with a known-good image rather than a leap of faith.
CANARY="${CONTAINER}-canary"
CANARY_PORT="${CANARY_PORT:-$((PORT + 100))}"

if [ "${SKIP_CANARY:-0}" = "1" ]; then
  log "SKIP_CANARY=1 — swapping without proving the new image first"
else
  log "Canary: starting $IMAGE as $CANARY on :$CANARY_PORT (the live container is untouched)"
  remove_canary
  if [ "$NETWORK" = host ]; then
    CANARY_NET_ARGS=(--network=host)
    CANARY_PORT_ARGS=(-e PORT="$CANARY_PORT")
  else
    CANARY_NET_ARGS=(--add-host=host.docker.internal:host-gateway -p "$CANARY_PORT:3000")
    CANARY_PORT_ARGS=()
  fi
  # The canary shares the production DATABASE_URL, so its background workers are
  # switched OFF: a second cron would send the same reminder twice and a second
  # IMAP poller would race the live one for the same inbox. These two flags are
  # the documented kill switches (src/instrumentation.ts). They come AFTER the
  # shared env list on purpose — docker takes the last `-e` for a given key, so
  # these override whatever the env file set.
  docker run -d \
    --name "$CANARY" \
    "${CANARY_NET_ARGS[@]}" \
    "${CANARY_PORT_ARGS[@]}" \
    "${APP_ENV_ARGS[@]}" \
    -e CRON_ENABLED=0 \
    -e INBOUND_IMAP_ENABLED=0 \
    "$IMAGE" >/dev/null

  if ! check_health "http://127.0.0.1:$CANARY_PORT/api/health?db=1" "$CANARY" "${GIT_SHA:0:7}"; then
    remove_canary
    echo "ERROR: the new image failed its canary check. NOTHING was swapped — $CONTAINER is still serving." >&2
    exit 1
  fi
  log "Canary OK — ${SERVED_SHA}, db ${SERVED_DB:-skipped}. Promoting."
  remove_canary
fi

# ── Rollback target ──────────────────────────────────────────────────────────
# Tag the image that is about to be replaced. Before #961 the outgoing image was
# deleted by `docker image prune -af`, so "put the previous release back" meant
# a rebuild — exactly what you cannot do when the runner is the thing that
# broke. Now it is a `docker run` away (--rollback below).
PREV_TAG="${CONTAINER}:previous"
OUTGOING_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true)"
if [ -n "$OUTGOING_IMAGE" ] && [ "$OUTGOING_IMAGE" != "$IMAGE" ]; then
  docker tag "$OUTGOING_IMAGE" "$PREV_TAG" 2>/dev/null \
    && log "Rollback target: $PREV_TAG (was $OUTGOING_IMAGE)" \
    || warn "could not tag $OUTGOING_IMAGE as $PREV_TAG — no rollback target for this deploy"
fi

# Swap ONE replica and prove it (#1701).
#
# Same three steps the single-container deploy always did — stop, run,
# health-assert — with the health check now part of the function rather than a
# separate stage, because with two replicas it is the thing that decides
# whether the second one is touched at all.
#
# `?db=1` rather than the root page: the root answers 200 from a container with
# a broken DATABASE_URL, and it says nothing about WHICH build is running. Both
# matter, because deploy-prod.yml's drift gate keys its "already current —
# nothing to deploy" decision off this same endpoint's `sha`. A container
# serving a stale image that happens to report the right sha would make the gate
# skip every future build.
swap_replica() { # swap_replica <index>
  local index="$1" name port
  name="$(replica_container "$index")"
  port="$(replica_port "$index")"
  local -a net_args extra_env
  mapfile -d '' -t net_args < <(replica_net_args "$port")
  extra_env=()
  mapfile -d '' -t extra_env < <(replica_extra_env "$index")

  log "Restarting $name on :$port (replica ${index}/${REPLICAS})"
  if [ "$REPLICAS" -gt 1 ]; then
    # Longer SIGTERM grace than docker's default 10s: the replica is out of the
    # pool at this point, so the time is spent finishing requests and
    # background work that is already in flight rather than on downtime. At
    # REPLICAS=1 the plain `docker stop` below keeps the historical timing.
    docker stop -t "$DRAIN_TIMEOUT_S" "$name" 2>/dev/null || true
  else
    docker stop "$name" 2>/dev/null || true
  fi
  docker rm "$name" 2>/dev/null || true
  # REPLICA_ID names the process in the lease table and on /api/health. It comes
  # AFTER the shared env list on purpose — docker takes the last `-e` for a key.
  docker run -d \
    --name "$name" \
    "${net_args[@]}" \
    --restart=unless-stopped \
    "${APP_ENV_ARGS[@]}" \
    ${extra_env[@]+"${extra_env[@]}"} \
    -e REPLICA_ID="$name" \
    "$IMAGE"

  log "Health check http://127.0.0.1:$port/api/health?db=1"
  check_health "http://127.0.0.1:$port/api/health?db=1" "$name" "${GIT_SHA:0:7}"
}

# ── 6. Roll through the replicas, one at a time ──────────────────────────────
# The canary already proved this image boots and reaches the database; this is
# the same assertion against the containers users actually reach.
#
# At REPLICAS=1 the loop runs once and no routing call is made at all — the
# deploy is exactly what it was. Above 1, each replica is taken OUT of the proxy
# pool before it is touched and put back only once it has answered with the sha
# just built, so traffic is served throughout by whichever replicas are still
# in the pool. If a replica fails its check the script stops right there, with
# that replica drained and the untouched ones still serving the previous image:
# a bad release cannot take both.
# Pre-flight, deliberately BEFORE the first container is touched: a box whose
# proxy this script cannot drive must fail the deploy while everything is still
# serving, not halfway through the roll. The pool it writes is the set that is
# already running, so on the very first two-replica deploy nothing is routed to
# the replica that does not exist yet.
if [ "$REPLICAS" -gt 1 ]; then
  route_pool "$(running_pool)" || {
    echo "ERROR: the reverse proxy could not be configured for $REPLICAS replicas." >&2
    echo "       NOTHING was swapped — the environment is still serving the previous release." >&2
    exit 1
  }
fi

REPLICA_INDEX=1
while [ "$REPLICA_INDEX" -le "$REPLICAS" ]; do
  THIS_PORT="$(replica_port "$REPLICA_INDEX")"
  if [ "$REPLICAS" -gt 1 ]; then
    log "Draining replica $REPLICA_INDEX (:$THIS_PORT) out of the pool"
    route_pool "$(pool_without "$THIS_PORT")" || warn "could not drain :$THIS_PORT from the pool — swapping it anyway, in-flight requests may see a retry"
  fi
  if ! swap_replica "$REPLICA_INDEX"; then
    echo "ERROR: replica $REPLICA_INDEX failed its health check." >&2
    if [ "$REPLICAS" -gt 1 ]; then
      echo "       It is OUT of the proxy pool and the remaining replica(s) are still serving" >&2
      echo "       the previous release. No further replica was touched." >&2
    fi
    echo "       Roll back with: CONTAINER=$CONTAINER REPLICAS=$REPLICAS ./infra/deploy-prod.sh --rollback" >&2
    exit 1
  fi
  if [ "$REPLICAS" -gt 1 ]; then
    route_pool "$(running_pool)" || warn "replica $REPLICA_INDEX is healthy but could not be routed back into the pool"
    log "Replica $REPLICA_INDEX OK — serving ${SERVED_SHA}, db ${SERVED_DB:-skipped}"
  fi
  REPLICA_INDEX=$((REPLICA_INDEX + 1))
done
log "Health OK — serving ${SERVED_SHA}, db ${SERVED_DB:-skipped} on ${REPLICAS} replica(s)"

# Record the commit now live in this container so the next deploy can enforce
# forward-only progress (see the guard above).
mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true
printf '%s\n' "$GIT_SHA" > "$STATE_FILE" 2>/dev/null || true

prune_images "$IMAGE" "$PREV_TAG"
log "Done — ${REPLICAS} replica(s) up from :$PORT (${GIT_SHA:0:7})"
