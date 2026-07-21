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
CONF="${NGINX_CONF_DIR}/crm-${TOPIC}.${BASE_DOMAIN}.conf"  # legacy raw route (cleaned up below)

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

# ── Container health (local) ─────────────────────────────────────────────────
sleep 3
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || echo "ERR")
echo "==> Container health http://127.0.0.1:${PORT}/api/health -> ${code}"

# ── Routing: Plesk-native subdomain (mirrors crm-preview) ────────────────────
# On this Plesk box every site is a Plesk vhost bound to the server IP
# (`listen <IP>:443 ssl`). A raw all-addresses `listen 443 ssl` block in conf.d
# loses the address-group match to those specific-IP vhosts, so its server_name
# is never considered and the request falls to Plesk's default vhost
# (login_up.php / 404). So we route the topic through a real Plesk subdomain and
# inject the same reverse-proxy crm-preview uses:
#     location ~ ^/.* { proxy_pass http://0.0.0.0:<container port>; }
SUBLABEL="crm-${TOPIC}"                 # e.g. crm-pr725
FQDN="crm-${TOPIC}.${BASE_DOMAIN}"      # e.g. crm-pr725.ersah.in
VHOST_CONF_DIR="/var/www/vhosts/system/${FQDN}/conf"

# Remove any leftover raw-nginx route from the earlier (pre-Plesk) approach so it
# can't linger with a duplicate server_name.
if [ -f "$CONF" ]; then rm -f "$CONF"; fi

command -v plesk >/dev/null || { echo "ERROR: plesk CLI not found on PATH" >&2; exit 1; }

# Create the subdomain (physical hosting + SSL) if it doesn't exist yet.
if plesk bin subdomain --info "$FQDN" >/dev/null 2>&1; then
  echo "==> Plesk subdomain ${FQDN} already exists"
else
  echo "==> Creating Plesk subdomain ${FQDN}"
  plesk bin subdomain --create "$SUBLABEL" -domain "$BASE_DOMAIN" -ssl true
fi

# ── Assign the existing *.${BASE_DOMAIN} wildcard cert to this subdomain ──────
# The wildcard already covers crm-pr<N>.${BASE_DOMAIN}, so we import that one cert
# into Plesk (idempotent) and assign it — no per-topic Let's Encrypt issuance.
# Non-fatal: if anything here fails the subdomain still serves with its default
# cert (Cloudflare terminates TLS at the edge anyway).
WILDCARD_CERT_NAME="wildcard-${BASE_DOMAIN}"
if [ -f "${CERT_DIR}/${BASE_DOMAIN}.cer" ] && [ -f "${CERT_DIR}/${BASE_DOMAIN}.key" ]; then
  if ! plesk bin certificate --info "$WILDCARD_CERT_NAME" -domain "$BASE_DOMAIN" >/dev/null 2>&1; then
    echo "==> Importing wildcard cert into Plesk as '${WILDCARD_CERT_NAME}'"
    # acme.sh writes a fullchain to .cer — split leaf (first block) from the CA chain.
    LEAF=$(mktemp); CHAIN=$(mktemp)
    awk 'BEGIN{n=0} /-BEGIN CERTIFICATE-/{n++} { if(n<=1) print > leaf; else print > chain }' \
      leaf="$LEAF" chain="$CHAIN" "${CERT_DIR}/${BASE_DOMAIN}.cer"
    if [ -s "$CHAIN" ]; then
      plesk bin certificate --create "$WILDCARD_CERT_NAME" -domain "$BASE_DOMAIN" \
        -cert-file "$LEAF" -key-file "${CERT_DIR}/${BASE_DOMAIN}.key" -cacert-file "$CHAIN" \
        || echo "WARN: wildcard cert import failed — keeping default cert"
    else
      plesk bin certificate --create "$WILDCARD_CERT_NAME" -domain "$BASE_DOMAIN" \
        -cert-file "${CERT_DIR}/${BASE_DOMAIN}.cer" -key-file "${CERT_DIR}/${BASE_DOMAIN}.key" \
        || echo "WARN: wildcard cert import failed — keeping default cert"
    fi
    rm -f "$LEAF" "$CHAIN"
  fi
  echo "==> Assigning '${WILDCARD_CERT_NAME}' to ${FQDN}"
  plesk bin subdomain --update "$SUBLABEL" -domain "$BASE_DOMAIN" -ssl true \
    -certificate-name "$WILDCARD_CERT_NAME" || echo "WARN: cert assignment failed — keeping default cert"
else
  echo "==> No wildcard cert files at ${CERT_DIR}/${BASE_DOMAIN}.cer(.key); using subdomain default cert"
fi

# Inject the reverse proxy to the container via Plesk's supported custom-nginx
# include, then have Plesk regenerate the vhost config (idempotent — rewritten
# each deploy).
mkdir -p "$VHOST_CONF_DIR"
cat > "${VHOST_CONF_DIR}/vhost_nginx.conf" <<NGINX
# Managed by infra/server/topic-deploy.sh — topic '${TOPIC}'. Do not edit by hand.
location ~ ^/.* {
    proxy_pass http://0.0.0.0:${PORT};
    proxy_http_version 1.1;
    proxy_set_header Host              \$host;
    proxy_set_header X-Real-IP         \$remote_addr;
    proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade           \$http_upgrade;
    proxy_set_header Connection        "upgrade";
}
NGINX

echo "==> Reconfiguring Plesk vhost for ${FQDN}"
plesk sbin httpdmng --reconfigure-domain "$FQDN"

# Verify the route resolves to the app locally (Host header hits the new vhost).
sleep 2
rcode=$(curl -s -k -o /dev/null -w '%{http_code}' -H "Host: ${FQDN}" "https://127.0.0.1/api/health" 2>/dev/null || echo "ERR")
echo "==> Route check (Host: ${FQDN}) -> ${rcode}"

# Reclaim space from older images.
docker image prune -af >/dev/null 2>&1 || true

echo "==> Topic '${TOPIC}' is live at ${URL}"
