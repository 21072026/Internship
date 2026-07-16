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
#   2. build the image FROM SOURCE (CI normally builds + pushes to ghcr; here we
#      build locally so no registry pull is needed), stamping GIT_SHA
#   3. prisma db push --accept-data-loss  (schema sync, same as CI)
#   4. seed-templates + backfill-project-members  (idempotent)
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
#   --skip-build  reuse the existing internship-crm:local image (fast restart)
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
for arg in "$@"; do
  case "$arg" in
    --no-pull) NO_PULL=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
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
  for k in DATABASE_URL NEXTAUTH_SECRET NEXTAUTH_URL SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_FROM; do
    v=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER" | sed -n "s/^$k=//p" | head -1)
    [ -n "$v" ] && printf '%s=%s\n' "$k" "$v" >> "$ENV_FILE"
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
GIT_SHA="$(git rev-parse HEAD)"
log "Deploying $(git rev-parse --short HEAD) — $(node -p "require('./package.json').version" 2>/dev/null || echo '?')"

# ── 2. Build image from source ───────────────────────────────────────────────
if [ "$SKIP_BUILD" -eq 0 ]; then
  log "Building $IMAGE (GIT_SHA=$GIT_SHA)"
  docker build --build-arg GIT_SHA="$GIT_SHA" -t "$IMAGE" .
fi

run_tool() { # run a one-off tool container on host networking with the prod DB
  docker run --rm --network=host -e DATABASE_URL="$DATABASE_URL" "$IMAGE" "$@"
}

# ── 3. Schema sync ────────────────────────────────────────────────────────────
log "prisma db push"
run_tool npx prisma db push --accept-data-loss

# ── 4. Idempotent seeds / backfills ──────────────────────────────────────────
log "seed-templates + project-member backfill (idempotent)"
run_tool node prisma/seed-templates.mjs || true
run_tool node prisma/backfill-project-members.mjs || true

# ── 5. Swap the container ────────────────────────────────────────────────────
log "Restarting $CONTAINER on :$PORT"
docker stop "$CONTAINER" 2>/dev/null || true
docker rm   "$CONTAINER" 2>/dev/null || true
docker run -d \
  --name "$CONTAINER" \
  --network=host \
  --restart=unless-stopped \
  -e PORT="$PORT" \
  -e DATABASE_URL="$DATABASE_URL" \
  -e NEXTAUTH_SECRET="$NEXTAUTH_SECRET" \
  -e NEXTAUTH_URL="$NEXTAUTH_URL" \
  -e NEXT_PUBLIC_APP_URL="$NEXTAUTH_URL" \
  -e SMTP_HOST="${SMTP_HOST:-}" \
  -e SMTP_PORT="${SMTP_PORT:-}" \
  -e SMTP_USER="${SMTP_USER:-}" \
  -e SMTP_PASS="${SMTP_PASS:-}" \
  -e SMTP_FROM="${SMTP_FROM:-}" \
  "$IMAGE"

# ── 6. Health check + prune ──────────────────────────────────────────────────
log "Health check http://127.0.0.1:$PORT"
ok=0
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT"; then ok=1; break; fi
  sleep 2
done
if [ "$ok" -ne 1 ]; then
  echo "ERROR: app did not answer on :$PORT within 60s. Recent logs:" >&2
  docker logs --tail 40 "$CONTAINER" >&2 || true
  exit 1
fi

docker image prune -af >/dev/null 2>&1 || true
docker builder prune -af --filter until=72h >/dev/null 2>&1 || true
log "Done — $CONTAINER is up at :$PORT ($(git rev-parse --short HEAD))"
