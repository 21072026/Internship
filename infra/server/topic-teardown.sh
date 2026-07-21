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
SUBLABEL="crm-${TOPIC}"
FQDN="crm-${TOPIC}.${BASE_DOMAIN}"
CONF="${NGINX_CONF_DIR}/crm-${TOPIC}.${BASE_DOMAIN}.conf"

echo "==> Tearing down topic '${TOPIC}'"

# Container image ref (to remove the image after stopping the container).
IMG=$(docker inspect --format '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true)

docker stop "$CONTAINER" 2>/dev/null || true
docker rm   "$CONTAINER" 2>/dev/null || true
[ -n "$IMG" ] && docker rmi "$IMG" 2>/dev/null || true

# Remove the Plesk subdomain (this drops its nginx vhost + route). Idempotent.
if command -v plesk >/dev/null && plesk bin subdomain --info "$FQDN" >/dev/null 2>&1; then
  echo "==> Removing Plesk subdomain ${FQDN}"
  plesk bin subdomain --remove "$SUBLABEL" -domain "$BASE_DOMAIN" || true
else
  echo "==> No Plesk subdomain ${FQDN} (already gone)"
fi

# Clean up any legacy raw-nginx route from the pre-Plesk approach.
if [ -f "$CONF" ]; then
  rm -f "$CONF"
  echo "==> Removed legacy nginx route ${CONF}; reloading nginx"
  eval "$NGINX_RELOAD_CMD" || true
fi

docker image prune -af >/dev/null 2>&1 || true
echo "==> Topic '${TOPIC}' torn down"
