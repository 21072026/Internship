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
#   4. seed-templates + seed-goal-templates + backfill-project-members (idempotent)
#   5. swap the internship-crm container (host networking, port 3200, restart
#      unless-stopped) — byte-for-byte the flags deploy.yml uses
#   6. health-check http://127.0.0.1:3200 and prune old images
#
# SECRETS never live in the repo. They are read from an env file on the server
# (same values as the GitHub secrets): DATABASE_URL, NEXTAUTH_SECRET,
# NEXTAUTH_URL, SMTP_HOST/PORT/USER/PASS/FROM. Default path /etc/internship-crm/prod.env
# (override with ENV_FILE=...). Create it once, chmod 600.
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
for arg in "$@"; do
  case "$arg" in
    --no-pull) NO_PULL=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    # The image already exists in the registry — fetching it replaces the build.
    --pull-image) PULL_IMAGE=1; SKIP_BUILD=1 ;;
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
           INBOUND_EMAIL_DOMAIN INBOUND_SECRET INBOUND_IMAP_HOST INBOUND_IMAP_PORT INBOUND_IMAP_USER \
           INBOUND_IMAP_PASS INBOUND_IMAP_MAILBOX INBOUND_IMAP_POLL_SECONDS INBOUND_IMAP_ENABLED \
           CRON_SECRET CRON_ENABLED; do
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

# Networking mode (#preview): prod runs on host networking with the DB at
# localhost. Preview's DB user is only granted from the docker gateway (not
# localhost), so preview must use bridge networking + host.docker.internal and
# a published port. Default 'host' keeps prod behavior byte-for-byte.
NETWORK="${NETWORK:-host}"
if [ "$NETWORK" = host ]; then
  APP_NET_ARGS=(--network=host)
  APP_PORT_ARGS=(-e PORT="$PORT")
  TOOL_NET_ARGS=(--network=host)
else
  # bridge: reach the host DB via host.docker.internal, publish the app port.
  APP_NET_ARGS=(--add-host=host.docker.internal:host-gateway -p "$PORT:3000")
  APP_PORT_ARGS=()
  TOOL_NET_ARGS=(--add-host=host.docker.internal:host-gateway)
fi

run_tool() { # run a one-off tool container against the DB (network per $NETWORK)
  docker run --rm "${TOOL_NET_ARGS[@]}" -e DATABASE_URL="$DATABASE_URL" "$IMAGE" "$@"
}

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
  # $DATABASE_URL names the DB as `host.docker.internal`, and that name exists
  # ONLY inside a container started with --add-host — on the host it does not
  # resolve, so preview's backup died with "Unknown server host" on every
  # deploy. The gateway address does resolve and connects.
  #
  # It is still not sufficient, and the log line below is honest about that:
  # MySQL sees a dump taken on the host as coming from the server's PUBLIC ip,
  # not from the gateway, so `crm-preview` is refused with error 1045. Granting
  # that user from the host's address (or dumping from inside a container that
  # already has the gateway grant) is the real fix and needs a decision on the
  # server — until then preview's backup is advisory, per the tiering above.
  BACKUP_DATABASE_URL="$DATABASE_URL"
  if [ "$NETWORK" != host ]; then
    DOCKER_GW="$(docker network inspect bridge \
      --format '{{ (index .IPAM.Config 0).Gateway }}' 2>/dev/null || true)"
    if [ -n "$DOCKER_GW" ]; then
      BACKUP_DATABASE_URL="${DATABASE_URL//host.docker.internal/$DOCKER_GW}"
      log "Backup will reach the DB at the docker gateway ($DOCKER_GW)"
    else
      log "!! Could not resolve the docker bridge gateway — backup will use $DATABASE_URL as-is"
    fi
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

log "prisma db push"
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
run_tool node prisma/backfill-project-members.mjs || true
run_tool node prisma/backfill-organization.mjs || true
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

# ── 5. Swap the container ────────────────────────────────────────────────────
log "Restarting $CONTAINER on :$PORT"
docker stop "$CONTAINER" 2>/dev/null || true
docker rm   "$CONTAINER" 2>/dev/null || true
docker run -d \
  --name "$CONTAINER" \
  "${APP_NET_ARGS[@]}" \
  --restart=unless-stopped \
  "${APP_PORT_ARGS[@]}" \
  -e DATABASE_URL="$DATABASE_URL" \
  -e NEXTAUTH_SECRET="$NEXTAUTH_SECRET" \
  -e NEXTAUTH_URL="$NEXTAUTH_URL" \
  -e NEXT_PUBLIC_APP_URL="$NEXTAUTH_URL" \
  -e SMTP_HOST="${SMTP_HOST:-}" \
  -e SMTP_PORT="${SMTP_PORT:-}" \
  -e SMTP_USER="${SMTP_USER:-}" \
  -e SMTP_PASS="${SMTP_PASS:-}" \
  -e SMTP_FROM="${SMTP_FROM:-}" \
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
  "$IMAGE"

# ── 6. Health check + prune ──────────────────────────────────────────────────
# Probe /api/health?db=1 rather than the root page: the root answers 200 from a
# container with a broken DATABASE_URL, and it says nothing about WHICH build is
# running. Both matter, because deploy-prod.yml's drift gate keys its
# "already current — nothing to deploy" decision off this same endpoint's `sha`.
# A container serving a stale image that happens to report the right sha would
# make the gate skip every future build.
log "Health check http://127.0.0.1:$PORT/api/health?db=1"
ok=0
health=''
for i in $(seq 1 30); do
  health="$(health_curl "http://127.0.0.1:$PORT/api/health?db=1" 2>/dev/null || true)"
  if [ -n "$health" ]; then ok=1; break; fi
  sleep 2
done
if [ "$ok" -ne 1 ]; then
  echo "ERROR: app did not answer on :$PORT within 60s. Recent logs:" >&2
  docker logs --tail 40 "$CONTAINER" >&2 || true
  exit 1
fi

health_field() { printf '%s' "$health" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"; }
SERVED_STATUS="$(health_field status)"
SERVED_SHA="$(health_field sha)"
SERVED_DB="$(health_field db)"

if [ "$SERVED_DB" = error ]; then
  echo "ERROR: $CONTAINER is up but cannot reach the database (health: $health)." >&2
  docker logs --tail 40 "$CONTAINER" >&2 || true
  exit 1
fi
if [ "$SERVED_STATUS" != ok ]; then
  echo "ERROR: $CONTAINER reported status '$SERVED_STATUS' (health: $health)." >&2
  exit 1
fi
# GIT_SHA is baked into the image at build time and truncated to 7 in
# src/lib/version.ts. 'dev' means the --build-arg was lost, which would also make
# the drift gate rebuild on every tick forever — treat it as a failure, not drift.
if [ "$SERVED_SHA" != "${GIT_SHA:0:7}" ]; then
  echo "ERROR: $CONTAINER is serving sha '$SERVED_SHA' but ${GIT_SHA:0:7} was just built and deployed." >&2
  echo "       A stale image is live and the drift gate would treat it as current. Not recording this deploy." >&2
  docker logs --tail 40 "$CONTAINER" >&2 || true
  exit 1
fi
log "Health OK — serving ${SERVED_SHA}, db ${SERVED_DB:-skipped}"

# Record the commit now live in this container so the next deploy can enforce
# forward-only progress (see the guard above).
mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true
printf '%s\n' "$GIT_SHA" > "$STATE_FILE" 2>/dev/null || true

docker image prune -af >/dev/null 2>&1 || true
docker builder prune -af --filter until=72h >/dev/null 2>&1 || true
log "Done — $CONTAINER is up at :$PORT (${GIT_SHA:0:7})"
