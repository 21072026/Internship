#!/usr/bin/env bash
#
# Server-side: bring up (or update) a topic preview environment.
# Run over SSH by .github/workflows/topic-preview.yml — NOT meant to be run by hand
# in CI's checkout; it executes on the Plesk host. The workflow pipes this file to
# `bash -s` with the needed vars exported in front of the command.
#
# Design decisions for this project (see infra/README.md):
#   - Routing: Plesk-native. We drop a self-contained nginx server block for
#     crm-<topic>.<BASE_DOMAIN> into $NGINX_CONF_DIR and reload nginx. This assumes
#     the stock `include /etc/nginx/conf.d/*.conf;` is active (default on Plesk) and
#     these hostnames are NOT Plesk-managed domains (only crm/crm-preview are), so
#     Plesk never rewrites these files.
#   - Database: a SINGLE shared preview DB (no per-topic DB). All topics push the
#     same schema. ⚠️ Trade-off: simultaneous topics with divergent schema changes
#     can drift — coordinate schema changes across concurrent topics.
#
# Required env (set by the workflow):
#   TOPIC PORT IMAGE BASE_DOMAIN
#
# Image source — one of:
#   (a) GHCR pull  (hosted workflow): ACTOR + B64_TOKEN, IMAGE is a ghcr.io ref.
#   (b) Local build (self-hosted runner): SKIP_PULL=1 and IMAGE already exists
#       locally (the workflow `docker build`s it on the server) — no registry.
#
# Secrets — one of:
#   (a) B64_DB B64_SEC B64_SMTP_HOST B64_SMTP_PORT B64_SMTP_USER B64_SMTP_PASS
#       B64_SMTP_FROM   (base64, piped over SSH by the hosted workflow), or
#   (b) ENV_FILE=/path/to/preview.env — sourced directly (self-hosted runner;
#       same file deploy-preview uses). Provides DATABASE_URL, NEXTAUTH_SECRET,
#       SMTP_*. NEXTAUTH_URL from the file is ignored — it's set per-topic below.
#
# Optional overrides (server paths / commands):
#   NGINX_CONF_DIR    (default /etc/nginx/conf.d)
#   NGINX_RELOAD_CMD  (default "nginx -t && systemctl reload nginx")
#   CERT_DIR          (default /etc/nginx/ssl)  — wildcard cert from acme-issue-wildcard.sh
#   SKIP_PULL=1       — image is already present locally; skip ghcr login + pull.
#
set -euo pipefail

: "${TOPIC:?}" "${PORT:?}" "${IMAGE:?}" "${BASE_DOMAIN:?}"
NGINX_CONF_DIR="${NGINX_CONF_DIR:-/etc/nginx/conf.d}"
NGINX_RELOAD_CMD="${NGINX_RELOAD_CMD:-nginx -t && systemctl reload nginx}"
CERT_DIR="${CERT_DIR:-/etc/nginx/ssl}"

# ── Secrets: explicit base64 (hosted) OR an env file (self-hosted) ───────────
if [ -n "${B64_DB:-}" ]; then
  DATABASE_URL=$(printf '%s' "$B64_DB" | base64 -d)
  NEXTAUTH_SECRET=$(printf '%s' "$B64_SEC" | base64 -d)
  SMTP_HOST=$(printf '%s' "${B64_SMTP_HOST:-}" | base64 -d)
  SMTP_PORT=$(printf '%s' "${B64_SMTP_PORT:-}" | base64 -d)
  SMTP_USER=$(printf '%s' "${B64_SMTP_USER:-}" | base64 -d)
  SMTP_PASS=$(printf '%s' "${B64_SMTP_PASS:-}" | base64 -d)
  SMTP_FROM=$(printf '%s' "${B64_SMTP_FROM:-}" | base64 -d)
elif [ -n "${ENV_FILE:-}" ] && [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
else
  echo "ERROR: no secrets — set the B64_* vars or point ENV_FILE at a readable env file" >&2
  exit 1
fi
: "${DATABASE_URL:?DATABASE_URL missing (B64_DB or ENV_FILE)}"
: "${NEXTAUTH_SECRET:?NEXTAUTH_SECRET missing (B64_SEC or ENV_FILE)}"

HOST="crm-${TOPIC}.${BASE_DOMAIN}"
URL="https://${HOST}"
CONTAINER="internship-crm-${TOPIC}"

echo "==> Deploying topic '${TOPIC}' → ${URL} (container ${CONTAINER}, port ${PORT})"

# ── Image: pull from GHCR unless it was built locally (self-hosted) ──────────
if [ "${SKIP_PULL:-0}" != "1" ]; then
  printf '%s' "${B64_TOKEN:?B64_TOKEN required when SKIP_PULL!=1}" | base64 -d \
    | docker login ghcr.io -u "${ACTOR:?ACTOR required when SKIP_PULL!=1}" --password-stdin
  docker pull "$IMAGE"
else
  docker image inspect "$IMAGE" >/dev/null 2>&1 || {
    echo "ERROR: SKIP_PULL=1 but image '$IMAGE' is not present locally" >&2; exit 1; }
fi

# Shared preview DB: reach the host's MySQL the same way the preview deploy does.
CONTAINER_DB=$(echo "$DATABASE_URL" | sed 's|localhost|host.docker.internal|g; s|127\.0\.0\.1|host.docker.internal|g')

# Apply schema + seed (idempotent). Shared DB, so this affects all topics.
docker run --rm --add-host=host.docker.internal:host-gateway \
  -e DATABASE_URL="$CONTAINER_DB" "$IMAGE" npx prisma db push --accept-data-loss
docker run --rm --add-host=host.docker.internal:host-gateway \
  -e DATABASE_URL="$CONTAINER_DB" "$IMAGE" node prisma/seed-templates.mjs || true

docker stop "$CONTAINER" 2>/dev/null || true
docker rm   "$CONTAINER" 2>/dev/null || true
docker run -d \
  --name "$CONTAINER" \
  -p "${PORT}:3000" \
  --add-host=host.docker.internal:host-gateway \
  --restart=unless-stopped \
  -e DATABASE_URL="$CONTAINER_DB" \
  -e NEXTAUTH_SECRET="$NEXTAUTH_SECRET" \
  -e NEXTAUTH_URL="$URL" \
  -e NEXT_PUBLIC_APP_URL="$URL" \
  -e SMTP_HOST="${SMTP_HOST:-}" \
  -e SMTP_PORT="${SMTP_PORT:-}" \
  -e SMTP_USER="${SMTP_USER:-}" \
  -e SMTP_PASS="${SMTP_PASS:-}" \
  -e SMTP_FROM="${SMTP_FROM:-}" \
  "$IMAGE"

# Routing: self-contained nginx server block for this topic, terminating TLS with
# the one wildcard cert. Written fresh each deploy (idempotent).
CONF="${NGINX_CONF_DIR}/crm-${TOPIC}.${BASE_DOMAIN}.conf"
cat > "$CONF" <<NGINX
# Managed by infra/server/topic-deploy.sh — topic '${TOPIC}'. Do not edit by hand.
server {
    listen 80;
    server_name ${HOST};
    return 301 https://\$host\$request_uri;
}
server {
    listen 443 ssl;
    server_name ${HOST};

    ssl_certificate     ${CERT_DIR}/${BASE_DOMAIN}.cer;
    ssl_certificate_key ${CERT_DIR}/${BASE_DOMAIN}.key;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade           \$http_upgrade;
        proxy_set_header Connection        "upgrade";
    }
}
NGINX

echo "==> Reloading nginx"
eval "$NGINX_RELOAD_CMD"

# Reclaim space from older images.
docker image prune -af >/dev/null 2>&1 || true

echo "==> Topic '${TOPIC}' is live at ${URL}"
