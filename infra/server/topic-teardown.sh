#!/usr/bin/env bash
#
# Server-side: tear a topic preview environment down when its PR is merged/closed.
# Run over SSH by .github/workflows/topic-preview.yml. Idempotent — safe to run for
# a topic that was never deployed (a no-op).
#
# Note: we use a SINGLE shared preview DB, so there is no per-topic database to
# drop here — only the container, its image, and the nginx route are removed.
#
# Required env:  TOPIC BASE_DOMAIN
# Optional overrides:
#   NGINX_CONF_DIR    (default /etc/nginx/conf.d)
#   NGINX_RELOAD_CMD  (default "nginx -t && systemctl reload nginx")
#
set -euo pipefail

: "${TOPIC:?}" "${BASE_DOMAIN:?}"
NGINX_CONF_DIR="${NGINX_CONF_DIR:-/etc/nginx/conf.d}"
NGINX_RELOAD_CMD="${NGINX_RELOAD_CMD:-nginx -t && systemctl reload nginx}"

CONTAINER="internship-crm-${TOPIC}"
CONF="${NGINX_CONF_DIR}/crm-${TOPIC}.${BASE_DOMAIN}.conf"

echo "==> Tearing down topic '${TOPIC}'"

# Container image ref (to remove the image after stopping the container).
IMG=$(docker inspect --format '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true)

docker stop "$CONTAINER" 2>/dev/null || true
docker rm   "$CONTAINER" 2>/dev/null || true
[ -n "$IMG" ] && docker rmi "$IMG" 2>/dev/null || true

if [ -f "$CONF" ]; then
  rm -f "$CONF"
  echo "==> Removed nginx route ${CONF}; reloading nginx"
  eval "$NGINX_RELOAD_CMD"
else
  echo "==> No nginx route file for topic '${TOPIC}' (already gone)"
fi

docker image prune -af >/dev/null 2>&1 || true
echo "==> Topic '${TOPIC}' torn down"
