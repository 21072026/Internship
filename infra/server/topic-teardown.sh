#!/usr/bin/env bash
#
# Server-side: tear a topic preview environment down when its PR is merged/closed.
# Run over SSH by .github/workflows/topic-preview.yml. Idempotent — safe to run for
# a topic that was never deployed (a no-op).
#
# Removes the container, its image, the Plesk route AND the topic's own database
# (#1185). The database is dropped because a per-PR database that outlives its
# PR is exactly the leak #962 found with containers, only quieter: it holds disk
# and it holds rows.
#
# Required env:  TOPIC BASE_DOMAIN
# Optional:
#   ENV_FILE          (default /etc/internship-crm/preview.env) — read ONLY for
#                     the MySQL host and credentials. Without it the container
#                     and route are still removed and the database is reported
#                     as skipped, never silently assumed gone.
#   KEEP_TOPIC_DB=1   keep the database (debugging a failed environment)
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

# ── The topic's own database (#1185) ─────────────────────────────────────────
TOPIC_DB="internship_${TOPIC}"
ENV_FILE="${ENV_FILE:-/etc/internship-crm/preview.env}"
if [ "${KEEP_TOPIC_DB:-0}" = "1" ]; then
  echo "==> KEEP_TOPIC_DB=1 — leaving ${TOPIC_DB} in place"
elif [ ! -f "$ENV_FILE" ]; then
  echo "WARN: ${ENV_FILE} not readable — cannot drop ${TOPIC_DB}. The daily topic sweep will pick it up."
else
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
  case "$TOPIC_DB" in
    internship_pr[0-9]*) : ;;
    # A DROP is not the place to trust a variable. Anything that is not
    # internship_pr<N> is refused outright rather than "cleaned up".
    *) echo "REFUSED: '${TOPIC_DB}' is not an internship_pr<N> database" >&2; TOPIC_DB="" ;;
  esac
  if [ -n "$TOPIC_DB" ] && [ -n "${DATABASE_URL:-}" ]; then
    _u="${DATABASE_URL#mysql://}"; _u="${_u%%\?*}"
    _creds="${_u%@*}"; _hostpart="${_u##*@}"
    _user="${_creds%%:*}"; _pass="${_creds#*:}"
    [ "$_pass" = "$_creds" ] && _pass=""
    _shared="${_hostpart#*/}"; _hostport="${_hostpart%%/*}"
    _host="${_hostport%%:*}"; _port="${_hostport#*:}"
    [ "$_port" = "$_hostport" ] && _port=3306
    _decode() { printf '%b' "${1//%/\\x}"; }
    _user="$(_decode "$_user")"; _pass="$(_decode "$_pass")"
    # The env file's host is written for the container; on the host itself
    # `host.docker.internal` resolves to nothing (#1185 follow-up).
    case "$_host" in host.docker.internal|docker.for.mac.localhost) _host=127.0.0.1 ;; esac
    if [ "$TOPIC_DB" = "$_shared" ]; then
      echo "REFUSED: ${TOPIC_DB} is the shared preview database" >&2
    elif command -v mysql >/dev/null; then
      echo "==> Dropping topic database ${TOPIC_DB}"
      # Same two routes as the deploy: the app user, then the local root socket
      # (this runs as root on the DB host). A database that survives teardown is
      # the leak this change exists to avoid, so it is worth the second attempt.
      _drop="DROP DATABASE IF EXISTS \`${TOPIC_DB}\`;"
      MYSQL_PWD="$_pass" mysql -h "$_host" -P "$_port" -u "$_user" -e "$_drop" 2>/dev/null \
        || { command -v plesk >/dev/null 2>&1 && printf '%s\n' "$_drop" | plesk db 2>/dev/null; } \
        || mysql --protocol=socket -u root -e "$_drop" 2>/dev/null \
        || echo "WARN: could not drop ${TOPIC_DB} — the daily topic sweep will retry"
    else
      echo "WARN: mysql client not found — ${TOPIC_DB} left in place"
    fi
  fi
fi

# Dangling only — NOT `-af`. Prod and preview keep their previous release as a
# stopped-but-tagged image (`internship-crm:previous`, #961); an unqualified
# prune here would delete production's rollback target as a side effect of
# closing a PR. This topic's own image was already removed by name above.
docker image prune -f >/dev/null 2>&1 || true
echo "==> Topic '${TOPIC}' torn down"
