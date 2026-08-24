#!/usr/bin/env bash
#
# Refresh the public demo (#1249, epic #966).
#
# WHY THIS EXISTS
#   The demo container was provisioned once, on 2026-08-19, and nothing ever
#   updated its IMAGE again. `demo-reset.yml` refreshes the data twice a day, so
#   the demo looked maintained while the software inside it aged — a "live demo"
#   that is months behind the product is worse than no demo, because it is
#   believed. This script is what a preview deploy calls to keep the demo on the
#   same build as preview.
#
# WHAT IT DOES
#   --image <ref>   recreate the container on that image, then wipe + re-seed
#                   (an image change can move the schema, so the data has to be
#                   rebuilt against it, not just left there)
#   --data-only     leave the container alone and only wipe + re-seed. This is
#                   the twice-daily reset.
#
#   Both end with the same health check, because both can leave the demo broken
#   in the same way: a stale Prisma client or a failed seed.
#
# NOT PROVISIONED IS NOT A FAILURE
#   The demo is optional (docs/DEMO.md). If the env file or the container is
#   missing, this exits 0 with a message: a preview deploy must not go red
#   because an optional environment was never set up on this box.
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/internship-crm/demo.env}"
CONTAINER="${CONTAINER:-internship-crm-demo}"
PORT="${PORT:-3203}"
IMAGE=""
DATA_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="${2:?--image needs a value}"; shift 2 ;;
    --data-only) DATA_ONLY=1; shift ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done
[ "$DATA_ONLY" = 1 ] || [ -n "$IMAGE" ] || { echo "ERROR: pass --image <ref> or --data-only" >&2; exit 2; }

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }

if [ ! -f "$ENV_FILE" ]; then
  log "No ${ENV_FILE} — the demo is not provisioned on this host (docs/DEMO.md). Nothing to do."
  exit 0
fi
command -v docker >/dev/null || { echo "ERROR: docker not found on PATH" >&2; exit 1; }

if ! docker inspect "$CONTAINER" >/dev/null 2>&1 && [ "$DATA_ONLY" = 1 ]; then
  log "No ${CONTAINER} container — the demo is not deployed. Nothing to reset."
  exit 0
fi

# ── Container: only recreate when the image actually changed ─────────────────
if [ "$DATA_ONLY" = 0 ]; then
  CURRENT="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true)"
  if [ "$CURRENT" = "$IMAGE" ]; then
    log "Demo already runs ${IMAGE} — leaving the container alone"
  else
    log "Demo: ${CURRENT:-<none>} → ${IMAGE}"
    docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE" >/dev/null
    docker stop "$CONTAINER" >/dev/null 2>&1 || true
    docker rm   "$CONTAINER" >/dev/null 2>&1 || true
    # The env file is the single source of truth for the demo's configuration —
    # nothing is passed in from CI, so no secret of the demo's ever reaches an
    # Actions log. DATABASE_URL there points at host.docker.internal, hence
    # bridge networking with a published port.
    docker run -d \
      --name "$CONTAINER" \
      --env-file "$ENV_FILE" \
      --add-host=host.docker.internal:host-gateway \
      -p "${PORT}:3000" \
      --restart=unless-stopped \
      "$IMAGE" >/dev/null
    RECREATED=1
  fi
fi

# ── Data: wipe + re-seed ─────────────────────────────────────────────────────
# Run INSIDE the container so the tools use exactly the image, Prisma client and
# DATABASE_URL the demo itself runs with. prisma/reset-demo.mjs refuses any
# database whose name does not end in `_demo` (infra/test/reset-demo-guard.test.sh).
run() { docker exec "$CONTAINER" "$@"; }

# A freshly started container needs a moment before `docker exec` is useful.
for i in $(seq 1 20); do
  docker exec "$CONTAINER" true >/dev/null 2>&1 && break
  sleep 1
done

log "Wiping (refuses anything not named *_demo)"
run node prisma/reset-demo.mjs
log "Re-applying the schema"
run npx prisma db push --accept-data-loss --skip-generate
log "Seeding the first admin"
run node prisma/seed.mjs
log "Seeding the synthetic demo dataset"
run node prisma/seed-demo.mjs

log "Health check http://127.0.0.1:${PORT}/api/health"
for i in $(seq 1 15); do
  if curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/api/health" >/dev/null; then
    log "Demo is healthy${RECREATED:+ on ${IMAGE}}"
    exit 0
  fi
  sleep 3
done
echo "ERROR: the demo did not answer /api/health after the refresh. Recent logs:" >&2
docker logs --tail 40 "$CONTAINER" >&2 || true
exit 1
