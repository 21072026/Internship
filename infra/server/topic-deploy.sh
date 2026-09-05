#!/usr/bin/env bash
#
# Server-side: bring up (or update) a topic preview environment.
# Run over SSH by .github/workflows/topic-preview.yml — NOT meant to be run by hand
# in CI's checkout; it executes on the Plesk host. The workflow pipes this file to
# `bash -s` with the needed vars exported in front of the command.
#
# Design decisions for this project (see infra/README.md):
#   - Routing: whichever reverse proxy the host actually runs, auto-detected.
#     CADDY (the new Oracle host, #2166): one generated file per topic in
#     $CADDY_SITES_DIR, then reload. Ten lines, no panel, no per-topic cert work.
#     PLESK (the old IONOS box): a real Plesk subdomain plus an injected
#     custom-nginx include, because Plesk owns 80/443 there and a raw conf.d
#     server block loses the address-group match (see the block itself).
#     The Plesk branch exists only until the old box is retired — delete it then,
#     along with NGINX_CONF_DIR/NGINX_RELOAD_CMD.
#   - Database: ONE DATABASE PER TOPIC (#1185). The env file points at the shared
#     preview DB; this script uses its host and credentials but redirects the
#     container to `internship_<TOPIC>` (e.g. internship_pr1315) on the same
#     MySQL server — a separate server would be cost for no isolation gained.
#     The database is created here, filled with synthetic demo data only, and
#     dropped by topic-teardown.sh when the PR closes.
#
#     Until #1185 every topic shared one preview database, so a `prisma db push`
#     on any PR reshaped the schema under every other PR (and under the shared
#     preview), and real preview data was visible from every topic environment.
#     Both of those are gone.
#
#     PRIVILEGES: the app user needs CREATE/DROP on `internship_pr%`. If it does
#     not have them, this script creates the database through the LOCAL ROOT
#     SOCKET (it runs as root on the DB host) and grants the app user access to
#     that one database. If neither route works the deploy STOPS with the grant
#     to run — it never falls back to the shared database, because isolation is
#     the entire point of #1185.
#
# Required env (set by the workflow):
#   TOPIC PORT IMAGE BASE_DOMAIN
#
# Image source — one of:
#   (a) GHCR pull (the normal path): IMAGE is a ghcr.io ref, built on a
#       GitHub-hosted runner. Credentials as GHCR_USER + GHCR_TOKEN, or as
#       ACTOR + B64_TOKEN when they have to survive an SSH hop.
#   (b) Local build: SKIP_PULL=1 and IMAGE already exists locally. Kept for a
#       manual deploy from a shell on the server; CI no longer builds here.
#
# Secrets — one of:
#   (a) B64_DB B64_SEC B64_SMTP_HOST B64_SMTP_PORT B64_SMTP_USER B64_SMTP_PASS
#       B64_SMTP_FROM   (base64, piped over SSH by the hosted workflow), or
#   (b) ENV_FILE=/path/to/preview.env — sourced directly (self-hosted runner;
#       same file deploy-preview uses). Provides DATABASE_URL, NEXTAUTH_SECRET,
#       SMTP_*, and JAAS_* when the video-call tenant is configured
#       (docs/video-calls-jaas.md). NEXTAUTH_URL from the file is ignored — it's
#       set per-topic below.
#
# Optional overrides (server paths / commands):
#   CADDY_SITES_DIR   (default /etc/caddy/sites)   — one <fqdn>.caddy per topic
#   CADDY_RELOAD_CMD  (default "caddy validate ... && systemctl reload caddy")
#   NGINX_CONF_DIR    (default /etc/nginx/conf.d)     — Plesk branch only
#   NGINX_RELOAD_CMD  (default "nginx -t && systemctl reload nginx") — Plesk only
#   CERT_DIR          (default /etc/nginx/ssl)  — wildcard cert from acme-issue-wildcard.sh
#   ROUTER            force "caddy" or "plesk" instead of auto-detecting
#   SKIP_PULL=1       — image is already present locally; skip ghcr login + pull.
#   GHCR_USER/GHCR_TOKEN — registry credentials in plain form (see (a) above).
#
set -euo pipefail

: "${TOPIC:?}" "${PORT:?}" "${IMAGE:?}" "${BASE_DOMAIN:?}"
NGINX_CONF_DIR="${NGINX_CONF_DIR:-/etc/nginx/conf.d}"
NGINX_RELOAD_CMD="${NGINX_RELOAD_CMD:-nginx -t && systemctl reload nginx}"
CERT_DIR="${CERT_DIR:-/etc/nginx/ssl}"
CADDY_SITES_DIR="${CADDY_SITES_DIR:-/etc/caddy/sites}"
CADDY_RELOAD_CMD="${CADDY_RELOAD_CMD:-caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy}"

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

# ── Image: pull from GHCR unless it was built locally ────────────────────────
if [ "${SKIP_PULL:-0}" != "1" ]; then
  if [ -n "${GHCR_TOKEN:-}" ]; then
    printf '%s' "$GHCR_TOKEN" \
      | docker login ghcr.io -u "${GHCR_USER:-github-actions}" --password-stdin
  else
    printf '%s' "${B64_TOKEN:?GHCR_TOKEN or B64_TOKEN required when SKIP_PULL!=1}" | base64 -d \
      | docker login ghcr.io -u "${ACTOR:?ACTOR required with B64_TOKEN}" --password-stdin
  fi
  docker pull "$IMAGE"
else
  docker image inspect "$IMAGE" >/dev/null 2>&1 || {
    echo "ERROR: SKIP_PULL=1 but image '$IMAGE' is not present locally" >&2; exit 1; }
fi

# ── This topic's own database (#1185) ────────────────────────────────────────
# The env file's DATABASE_URL supplies the SERVER and the CREDENTIALS; the
# database it names (the shared preview one) is never touched from here.
TOPIC_DB="internship_${TOPIC}"
case "$TOPIC_DB" in
  internship_pr[0-9]*) : ;;
  *) echo "ERROR: refusing to create database '${TOPIC_DB}' — expected internship_pr<N>" >&2; exit 1 ;;
esac

# Parse mysql://user:pass@host:port/db from the OUTSIDE in — the password may
# contain @ : / and $, so one greedy regex gets it wrong (same approach as
# infra/backup-db.sh).
_u="${DATABASE_URL#mysql://}"; _u="${_u%%\?*}"
_creds="${_u%@*}"; _hostpart="${_u##*@}"
DB_USER="${_creds%%:*}"; DB_PASS="${_creds#*:}"
[ "$DB_PASS" = "$_creds" ] && DB_PASS=""
SHARED_DB="${_hostpart#*/}"; _hostport="${_hostpart%%/*}"
DB_HOST="${_hostport%%:*}"; DB_PORT="${_hostport#*:}"
[ "$DB_PORT" = "$_hostport" ] && DB_PORT=3306
_decode() { printf '%b' "${1//%/\\x}"; }
DB_USER="$(_decode "$DB_USER")"; DB_PASS="$(_decode "$DB_PASS")"

# The env file's URL is written for the CONTAINER, so its host is often
# `host.docker.internal` — a name that only resolves INSIDE a container. This
# script runs on the host, where the same server is reachable on loopback.
# (Without this the very first deploy failed instantly: every mysql call, app
# user and admin alike, could not resolve the host at all.)
case "$DB_HOST" in
  host.docker.internal|docker.for.mac.localhost) DB_HOST=127.0.0.1 ;;
esac

if [ "$TOPIC_DB" = "$SHARED_DB" ]; then
  echo "ERROR: topic database name equals the shared preview database ('${SHARED_DB}')" >&2
  exit 1
fi

command -v mysql >/dev/null || { echo "ERROR: mysql client not found on the host" >&2; exit 1; }
_sql() { MYSQL_PWD="$DB_PASS" mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" --batch --skip-column-names "$@"; }
# This script runs as root ON the database host, so when the app user has not
# been granted CREATE on the topic databases we can still do it as an admin —
# and grant the app user access to what we just created, so the container can
# actually connect. Without this the feature would need a manual GRANT before
# the first PR, and every topic preview would break until somebody ran it.
#
# Two admin routes, in order. `plesk db` first because this IS a Plesk box and
# there the MySQL root account is not socket-authenticated — Plesk holds the
# admin credentials and hands them to the client for you. The plain root socket
# is the fallback for a non-Plesk host.
_admin_sql() {
  if command -v plesk >/dev/null 2>&1; then
    if printf '%s\n' "$1" | plesk db --batch --skip-column-names 2>/dev/null; then return 0; fi
    if plesk db -e "$1" 2>/dev/null; then return 0; fi
  fi
  mysql --protocol=socket -u root --batch --skip-column-names -e "$1" 2>/dev/null
}

# Is this the first deploy of this PR, or a re-push into an existing database?
# A fresh one gets seeded; an existing one keeps whatever the reviewer has been
# clicking on, and only gets the schema brought up to date.
EXISTING_TABLES=$(_sql -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${TOPIC_DB}';" 2>/dev/null || echo 0)

echo "==> Topic database: ${TOPIC_DB} on ${DB_HOST}:${DB_PORT} (shared preview DB '${SHARED_DB}' is NOT used)"
CREATE_SQL="CREATE DATABASE IF NOT EXISTS \`${TOPIC_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
if ! _sql -e "$CREATE_SQL" 2>/dev/null; then
  echo "==> App user cannot create databases; creating it as a MySQL admin"
  if _admin_sql "$CREATE_SQL"; then
    # Grant to every host the account actually exists under. Guessing '%' is how
    # this silently half-works: an account defined as 'user'@'localhost' gets a
    # grant that never applies to it, and the container then cannot connect to
    # the database we just made.
    granted=0
    # Filter the host list rather than trusting it: if the first admin route
    # ever falls through to a client that prints a bordered table, the "hosts"
    # would be `+------+` and `|` — and those would go straight into a GRANT.
    # Only things that can actually be a MySQL host survive.
    for h in $(_admin_sql "SELECT host FROM mysql.user WHERE user='${DB_USER}';" \
               | grep -E '^[A-Za-z0-9_.%:-]+$' || true); do
      _admin_sql "GRANT ALL PRIVILEGES ON \`${TOPIC_DB}\`.* TO '${DB_USER}'@'${h}';" && granted=1
    done
    [ "$granted" = 1 ] || _admin_sql "GRANT ALL PRIVILEGES ON \`${TOPIC_DB}\`.* TO '${DB_USER}'@'%';"
    _admin_sql "FLUSH PRIVILEGES;" >/dev/null
    # Prove it: the grant is worth nothing if the app user still cannot use the
    # database, and finding that out here beats finding it out from a container
    # that will not boot.
    if ! _sql -e "USE \`${TOPIC_DB}\`; SELECT 1;" >/dev/null 2>&1; then
      echo "ERROR: created ${TOPIC_DB} but '${DB_USER}' still cannot access it." >&2
      echo "       Grant it once, as a MySQL admin:" >&2
      echo "       GRANT ALL PRIVILEGES ON \`internship\\_pr%\`.* TO '${DB_USER}'@'%';" >&2
      exit 1
    fi
    echo "==> Created ${TOPIC_DB} as admin and granted it to '${DB_USER}'"
  else
    echo "ERROR: could not create ${TOPIC_DB} — neither '${DB_USER}' nor a local admin could." >&2
    echo "       Grant it once, as a MySQL admin:" >&2
    echo "       GRANT ALL PRIVILEGES ON \`internship\\_pr%\`.* TO '${DB_USER}'@'%';" >&2
    echo "       Refusing to fall back to the shared preview database — isolation is the point (#1185)." >&2
    exit 1
  fi
fi

# Point the container at the topic database. String surgery on the ORIGINAL URL
# rather than reassembling it from the parsed parts, so a percent-encoded
# password survives untouched.
_base="${DATABASE_URL%%\?*}"; _base="${_base%/*}"
_query=""
case "$DATABASE_URL" in *\?*) _query="?${DATABASE_URL#*\?}" ;; esac
TOPIC_DATABASE_URL="${_base}/${TOPIC_DB}${_query}"

# Reach the host's MySQL from inside the container the same way the preview
# deploy does.
CONTAINER_DB=$(echo "$TOPIC_DATABASE_URL" | sed 's|localhost|host.docker.internal|g; s|127\.0\.0\.1|host.docker.internal|g')

_in_image() {
  docker run --rm --add-host=host.docker.internal:host-gateway \
    -e DATABASE_URL="$CONTAINER_DB" "$@"
}

if [ "${EXISTING_TABLES:-0}" -gt 0 ]; then
  # An existing topic database predates this push and may carry rows written by
  # an older schema — the same repairs prod runs before its push (#1288).
  _in_image "$IMAGE" node prisma/push-company-interest-expand.mjs || true
  _in_image "$IMAGE" node prisma/backfill-company-interest-scope.mjs || true
  _in_image "$IMAGE" node prisma/backfill-json-columns.mjs --repair || true
fi

_in_image "$IMAGE" npx prisma db push --accept-data-loss
_in_image "$IMAGE" node prisma/seed-templates.mjs || true
_in_image "$IMAGE" node prisma/seed-contributor-terms.mjs || true
_in_image "$IMAGE" node scripts/backfill-requisitions.mjs || true

if [ "${EXISTING_TABLES:-0}" -eq 0 ]; then
  # First deploy of this PR: fill it with the synthetic demo set. Nothing here
  # comes from a real person — that is the whole point of #1184. SEED_DEMO_FORCE
  # only unlocks an internship_pr<N> target (prisma/seed-demo.mjs); it cannot
  # reach preview or prod even if this script were called with the wrong URL.
  echo "==> Fresh topic database — seeding synthetic demo data"
  docker run --rm --add-host=host.docker.internal:host-gateway \
    -e DATABASE_URL="$CONTAINER_DB" -e SEED_DEMO_FORCE=1 \
    "$IMAGE" node prisma/seed-demo.mjs || echo "WARN: demo seeding failed — the environment is up but empty"
else
  echo "==> Existing topic database (${EXISTING_TABLES} tables) — keeping its data"
fi

docker stop "$CONTAINER" 2>/dev/null || true
docker rm   "$CONTAINER" 2>/dev/null || true
# OPERATOR_* (#1396) is forwarded like the rest: same host, same operator, so a
# topic env shows the real /imprint a reviewer is here to look at. Absent from
# the env file it renders the "no imprint published" state, which is the other
# half worth being able to see.
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
  -e OPERATOR_DPO="${OPERATOR_DPO:-}" \
  "$IMAGE"

# ── Container health (local) ─────────────────────────────────────────────────
sleep 3
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || echo "ERR")
echo "==> Container health http://127.0.0.1:${PORT}/api/health -> ${code}"

# ── Routing ──────────────────────────────────────────────────────────────────
SUBLABEL="crm-${TOPIC}"                 # e.g. crm-pr725
FQDN="crm-${TOPIC}.${BASE_DOMAIN}"      # e.g. crm-pr725.interncrm.com

# Which reverse proxy sits in front of the containers? The new host runs Caddy and
# has no panel; the old one runs Plesk, which owns 80/443 there. Auto-detect, so
# one script serves both boxes while the migration is in flight (#2166).
ROUTER="${ROUTER:-}"
if [ -z "$ROUTER" ]; then
  if command -v caddy >/dev/null 2>&1; then ROUTER=caddy
  elif command -v plesk >/dev/null 2>&1; then ROUTER=plesk
  else echo "ERROR: neither caddy nor plesk found on PATH" >&2; exit 1; fi
fi
echo "==> Router: ${ROUTER}"

route_caddy() {
# This is the whole thing — the ~90 lines the Plesk branch needs for the same job.
mkdir -p "$CADDY_SITES_DIR"

# Prefer the installed wildcard cert. NOT an optimisation: this repo merged its
# last 100 PRs in 9 days and every PR gets its own hostname, while Let's Encrypt
# allows 50 certificates per registered domain per week. Per-hostname issuance
# would exhaust the domain's quota within days and topic environments would then
# fail TLS with nothing in this script looking wrong.
tls_line=""
if [ -f "${CERT_DIR}/${BASE_DOMAIN}.cer" ] && [ -f "${CERT_DIR}/${BASE_DOMAIN}.key" ]; then
  tls_line="    tls ${CERT_DIR}/${BASE_DOMAIN}.cer ${CERT_DIR}/${BASE_DOMAIN}.key"
else
  echo "==> WARN: no wildcard cert at ${CERT_DIR}/${BASE_DOMAIN}.cer — Caddy will issue per-host (50/week/domain limit)"
fi

# reverse_proxy appends the peer to X-Forwarded-For and upgrades WebSockets by
# itself, so this stays ONE proxy hop and TRUSTED_PROXY_COUNT=1 remains correct
# (src/lib/rateLimit.ts). Moving this hostname behind Cloudflare's proxy would
# make it two — bump the count in that same change.
{
  echo "# Managed by infra/server/topic-deploy.sh — topic '${TOPIC}'. Do not edit by hand."
  echo "${FQDN} {"
  # `[ -n "$x" ] && echo` would be a non-zero statement under `set -e` when the
  # cert is absent; an `if` says the same thing without depending on how bash
  # treats a failing AND-list.
  if [ -n "$tls_line" ]; then echo "$tls_line"; fi
  echo "    reverse_proxy 127.0.0.1:${PORT}"
  echo "}"
} > "${CADDY_SITES_DIR}/${FQDN}.caddy"

# Validate before reloading: Caddy loads one config for the whole box, so a bad
# topic file would take production, preview and every other topic down with it.
if ! eval "$CADDY_RELOAD_CMD"; then
  rm -f "${CADDY_SITES_DIR}/${FQDN}.caddy"
  eval "$CADDY_RELOAD_CMD" || true
  echo "ERROR: caddy rejected the generated site file; removed it and reloaded" >&2
  exit 1
fi
echo "==> Caddy route ${FQDN} -> 127.0.0.1:${PORT}"
}

route_plesk() {
# ── Routing: Plesk-native subdomain (mirrors crm-preview) ────────────────────
# On this Plesk box every site is a Plesk vhost bound to the server IP
# (`listen <IP>:443 ssl`). A raw all-addresses `listen 443 ssl` block in conf.d
# loses the address-group match to those specific-IP vhosts, so its server_name
# is never considered and the request falls to Plesk's default vhost
# (login_up.php / 404). So we route the topic through a real Plesk subdomain and
# inject the same reverse-proxy crm-preview uses:
#     location ~ ^/.* { proxy_pass http://0.0.0.0:<container port>; }
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
}

if [ "$ROUTER" = caddy ]; then route_caddy; else route_plesk; fi

# Verify the route resolves to the app locally (Host header hits the new route).
sleep 2
rcode=$(curl -s -k -o /dev/null -w '%{http_code}' -H "Host: ${FQDN}" "https://127.0.0.1/api/health" 2>/dev/null || echo "ERR")
echo "==> Route check (Host: ${FQDN}) -> ${rcode}"

# Reclaim space from older images — but never the rollback targets. `-af`
# removes every image no container is using, and prod/preview keep their
# previous release as a stopped-but-tagged image (`internship-crm:previous`,
# #961). A topic deploy pruning that away would silently delete production's way
# back. Dangling layers only, plus topic images nothing is running.
docker image prune -f >/dev/null 2>&1 || true
docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \
  | grep -E '^ghcr\.io/[^:]+:topic-pr[0-9]+$' \
  | grep -vx "$IMAGE" \
  | xargs -r docker rmi >/dev/null 2>&1 || true

echo "==> Topic '${TOPIC}' is live at ${URL}"
