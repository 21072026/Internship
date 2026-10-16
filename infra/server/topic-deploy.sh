#!/usr/bin/env bash
#
# Server-side: bring up (or update) a topic preview environment.
# Run over SSH by .github/workflows/topic-preview.yml — NOT meant to be run by hand
# in CI's checkout; it executes on the Plesk host. The workflow pipes this file to
# `bash -s` with the needed vars exported in front of the command.
#
# Design decisions for this project (see infra/README.md):
#   - Routing: whichever reverse proxy the host actually runs, auto-detected.
#     CADDY (the new Oracle host, #2166): TWO generated files per topic in
#     $CADDY_SITES_DIR, then reload. Internship at pr<N>.<domain>, marketing at
#     pr<N>-m.<domain> (#2612) — both one DNS label so the *.interncrm.com
#     wildcard cert covers them. No per-topic Let's Encrypt issuance.
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
#   ENV_PREFIX        (default "") — hostname prefix, see the note at SUBLABEL
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
# Where the wildcard certificate lives differs per host. The Plesk box kept it
# under nginx's ssl dir; on the migrated box bootstrap.sh creates
# /etc/caddy/certs owned by the deploy user, and that is where wildcard-cert.yml
# installs it. Defaulting to the nginx path on a Caddy host meant the cert was
# never found and every topic env silently fell back to per-hostname issuance —
# 50 certificates per domain per week, which this repo's PR rate exhausts in
# days, after which topic environments fail TLS with nothing looking wrong (#2213).
if [ -z "${CERT_DIR:-}" ]; then
  if [ -d /etc/caddy/certs ]; then CERT_DIR=/etc/caddy/certs; else CERT_DIR=/etc/nginx/ssl; fi
fi
# Hostname prefix for environment names. Empty by default: on a domain bought
# for this product, `pr123.<domain>` says everything `crm-pr123.<domain>` did.
# The `crm-` prefix existed because the app used to live under a personal domain
# shared with other services, where it had to distinguish itself.
ENV_PREFIX="${ENV_PREFIX:-}"
CADDY_SITES_DIR="${CADDY_SITES_DIR:-/etc/caddy/sites}"
# Writing a site file and reloading the service both need privilege the runner
# does not have as itself: bootstrap.sh creates /etc/caddy/sites as root:caddy
# 0775 and adds the deploy user to `docker` but never to `caddy`, and
# `systemctl reload` is root-only regardless of that. wildcard-cert.yml already
# reloads this same service with `sudo systemctl reload caddy`, so sudo is
# available on this box — use it rather than inventing a second mechanism.
# Running as root (bootstrap, a manual run) skips sudo entirely.
_SUDO=""; [ "$(id -u)" -eq 0 ] || _SUDO="sudo "
_priv() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }
CADDY_RELOAD_CMD="${CADDY_RELOAD_CMD:-caddy validate --config /etc/caddy/Caddyfile && ${_SUDO}systemctl reload caddy}"

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

# The hostname the reverse proxy actually serves. This MUST follow ENV_PREFIX,
# because the routing block below builds FQDN the same way — when this line
# hardcoded `crm-` (its shape before ENV_PREFIX was emptied in #2182) the
# container was told NEXTAUTH_URL=https://crm-pr<N>.<domain> while Caddy served
# pr<N>.<domain>, so every sign-in callback on a topic env pointed at a host
# that does not resolve.
HOST="${ENV_PREFIX}${TOPIC}.${BASE_DOMAIN}"
# Second public host on the SAME wildcard (#2612). Option A in the issue used a
# per-PR name under the preview marketing domain, which would mint a new
# certificate per PR (50/week/domain). pr<N>-m.<BASE_DOMAIN> is still two worlds on two hosts,
# and it rides the cert this script already prefers. Do NOT inherit
# MARKETING_HOSTS from ENV_FILE — that file names the shared preview domain.
MARKETING_HOST="${ENV_PREFIX}${TOPIC}-m.${BASE_DOMAIN}"
URL="https://${HOST}"
MARKETING_URL="https://${MARKETING_HOST}"
CONTAINER="internship-crm-${TOPIC}"
CONF="${NGINX_CONF_DIR}/crm-${TOPIC}.${BASE_DOMAIN}.conf"  # legacy raw route (cleaned up below)

echo "==> Deploying topic '${TOPIC}' → ${URL} + ${MARKETING_URL} (container ${CONTAINER}, port ${PORT})"

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

# ── Networking mode (#2213) ──────────────────────────────────────────────────
# How a container reaches the host's MySQL is a property of the HOST, not of
# this script, and it changed under us in #2166. On the old Plesk box MariaDB
# was reachable on the docker bridge, so `host.docker.internal` mapped to
# host-gateway worked. The migrated box publishes MySQL on 127.0.0.1 only,
# where the gateway address (172.17.0.1) reaches nothing — this script kept
# the bridge unconditionally and every topic deploy since the cutover died on
# "P1001: Can't reach database server at host.docker.internal:3306".
#
# deploy-prod.sh (:155) and demo-refresh.sh (:72) were both given this switch
# during the migration; this, the third caller of the same pattern, was missed.
# Default 'host' matches them. NETWORK=bridge restores the old behaviour for a
# host whose DB user is granted from the gateway rather than from loopback.
NETWORK="${NETWORK:-host}"
if [ "$NETWORK" = host ]; then
  # Container shares the host's network namespace: the loopback URL is already
  # correct, and the app is told which port to bind instead of publishing one.
  CONTAINER_DB=$(echo "$TOPIC_DATABASE_URL" | sed 's|host\.docker\.internal|127.0.0.1|g')
  NET_ARGS=(--network=host)
  APP_NET_ARGS=(--network=host -e PORT="$PORT")
else
  CONTAINER_DB=$(echo "$TOPIC_DATABASE_URL" | sed 's|localhost|host.docker.internal|g; s|127\.0\.0\.1|host.docker.internal|g')
  NET_ARGS=(--add-host=host.docker.internal:host-gateway)
  APP_NET_ARGS=(--add-host=host.docker.internal:host-gateway -p "${PORT}:3000")
fi
echo "==> Container networking: ${NETWORK}"

_in_image() {
  docker run --rm "${NET_ARGS[@]}" \
    -e DATABASE_URL="$CONTAINER_DB" "$@"
}

if [ "${EXISTING_TABLES:-0}" -gt 0 ]; then
  # An existing topic database predates this push and may carry rows written by
  # an older schema — the same repairs prod runs before its push (#1288).
  _in_image "$IMAGE" node prisma/push-company-interest-expand.mjs || true
  _in_image "$IMAGE" node prisma/backfill-company-interest-scope.mjs || true
  _in_image "$IMAGE" node prisma/push-setting-id-expand.mjs || true
  _in_image "$IMAGE" node prisma/backfill-setting-id.mjs || true
  _in_image "$IMAGE" node prisma/backfill-json-columns.mjs --repair || true
fi

_in_image "$IMAGE" npx prisma db push --accept-data-loss
_in_image "$IMAGE" node prisma/seed-templates.mjs || true
_in_image "$IMAGE" node prisma/seed-contributor-terms.mjs || true

if [ "${EXISTING_TABLES:-0}" -eq 0 ]; then
  # First deploy of this PR: fill it with the synthetic demo set. Nothing here
  # comes from a real person — that is the whole point of #1184. SEED_DEMO_FORCE
  # only unlocks an internship_pr<N> target (prisma/seed-demo.mjs); it cannot
  # reach preview or prod even if this script were called with the wrong URL.
  echo "==> Fresh topic database — seeding synthetic demo data"
  docker run --rm "${NET_ARGS[@]}" \
    -e DATABASE_URL="$CONTAINER_DB" -e SEED_DEMO_FORCE=1 \
    "$IMAGE" node prisma/seed-demo.mjs || echo "WARN: demo seeding failed — the environment is up but empty"
else
  echo "==> Existing topic database (${EXISTING_TABLES} tables) — keeping its data"
fi

# Tenant backfill (#1557), after the seeds because they create fresh org-less
# rows. A topic environment is where the MT_ENFORCE_ISOLATION rollout is meant
# to be rehearsed, so it has to run here too, not only in deploy-prod.sh.
# Per-tenant attribution before the default-org fill (see deploy-prod.sh).
_in_image "$IMAGE" node prisma/backfill-activity-log-org.mjs || true
_in_image "$IMAGE" node prisma/backfill-task-template-org.mjs || true
_in_image "$IMAGE" node prisma/backfill-ai-usage-org.mjs || true
_in_image "$IMAGE" node prisma/backfill-ai-usage-task.mjs || true
_in_image "$IMAGE" node prisma/backfill-organization.mjs \
  || echo "WARN: org backfill FAILED (exit non-zero) — see the output above"
# Legacy needs require company orgId; include rows created by the demo seed.
_in_image "$IMAGE" node scripts/backfill-requisitions.mjs || true

# Point the demo MARKETING org at THIS topic's marketing host so the landing
# demo form opens and e-mail links stay on the topic env, not production
# (#2569 / #2612). Idempotent; a topic DB seeded before this change is patched
# on the next push. Missing org (an ancient empty DB) is a warning, not a halt.
_in_image "$IMAGE" node prisma/set-public-host.mjs --org demo-marketing --host "$MARKETING_HOST" \
  || echo "WARN: could not map demo-marketing publicHost → ${MARKETING_HOST}"

# ── Mail sink (#2953) ────────────────────────────────────────────────────────
# A topic environment never spends the shared relay's budget: every mail it
# sends goes to ONE Mailpit container shared by all topic environments on this
# box — it accepts anything, keeps the last messages for a look, and relays
# nothing. Only mail whose recipients are ALL on MAIL_RECIPIENT_ALLOWLIST (from
# the env file; TOPIC_MAIL_RECIPIENT_ALLOWLIST overrides it there) still goes
# through the real relay (src/lib/mailSinkRule.ts).
#
# Never published publicly: SMTP and the web UI are bound to 127.0.0.1 on the
# box (host networking reaches them there), plus a private docker network for a
# bridge-mode container. To read the sink: an SSH tunnel to the UI —
#   ssh -L 8025:127.0.0.1:8025 <box>   then open http://localhost:8025
# (infra/README.md § The mail sink).
#
# Started idempotently. If it cannot be started, MAIL_SINK_HOST is STILL set:
# the app then fails to reach the sink, queues the mail and retries it against
# the sink — it never falls back to the real relay. The image is pinned; bump it
# by hand.
MAIL_SINK_CONTAINER="${MAIL_SINK_CONTAINER:-internship-mail-sink}"
MAIL_SINK_IMAGE="${MAIL_SINK_IMAGE:-axllent/mailpit:v1.31.3}"
MAIL_SINK_NETWORK="${MAIL_SINK_NETWORK:-internship-mail-sink}"
docker network inspect "$MAIL_SINK_NETWORK" >/dev/null 2>&1 \
  || docker network create "$MAIL_SINK_NETWORK" >/dev/null 2>&1 \
  || echo "WARN: could not create the docker network ${MAIL_SINK_NETWORK}"
# Never removed here: two topic deploys can run at once, and one that found the
# sink briefly not running (restarting, or just being created by the other)
# must not wipe it and its messages. An existing container is started; only a
# missing one is created — and losing that name race to a concurrent deploy is
# fine, the other one created it.
MAIL_SINK_STATE="$(docker inspect -f '{{.State.Running}}' "$MAIL_SINK_CONTAINER" 2>/dev/null | tr -d '[:space:]' || true)"
[ -n "$MAIL_SINK_STATE" ] || MAIL_SINK_STATE=missing
if [ "$MAIL_SINK_STATE" = "true" ]; then
  echo "==> Mail sink running (${MAIL_SINK_CONTAINER})"
elif [ "$MAIL_SINK_STATE" != "missing" ]; then
  docker start "$MAIL_SINK_CONTAINER" >/dev/null 2>&1 \
    && echo "==> Mail sink started again (${MAIL_SINK_CONTAINER})" \
    || echo "WARN: mail sink exists but could not be started — this environment's mail will wait on its queue"
else
  # MP_MAX_MESSAGES bounds the store: the sink is a window, not an archive.
  docker run -d \
    --name "$MAIL_SINK_CONTAINER" \
    --restart=unless-stopped \
    --network "$MAIL_SINK_NETWORK" \
    -p 127.0.0.1:1025:1025 \
    -p 127.0.0.1:8025:8025 \
    -e MP_MAX_MESSAGES=2000 \
    "$MAIL_SINK_IMAGE" >/dev/null \
    && echo "==> Mail sink started (${MAIL_SINK_CONTAINER}, ${MAIL_SINK_IMAGE})" \
    || { [ "$(docker inspect -f '{{.State.Running}}' "$MAIL_SINK_CONTAINER" 2>/dev/null || true)" = "true" ] \
         && echo "==> Mail sink running (${MAIL_SINK_CONTAINER}, started by a concurrent deploy)"; } \
    || echo "WARN: mail sink could not be started — this environment's mail will wait on its queue"
fi
if [ "$NETWORK" = host ]; then
  TOPIC_MAIL_SINK_HOST=127.0.0.1
else
  # A bridge-mode container reaches the sink by name on the private network
  # (connected below, once the container exists).
  TOPIC_MAIL_SINK_HOST="$MAIL_SINK_CONTAINER"
fi

docker stop "$CONTAINER" 2>/dev/null || true
docker rm   "$CONTAINER" 2>/dev/null || true
# OPERATOR_* (#1396) is forwarded like the rest: same host, same operator, so a
# topic env shows the real /imprint a reviewer is here to look at. Absent from
# the env file it renders the "no imprint published" state, which is the other
# half worth being able to see.
docker run -d \
  --name "$CONTAINER" \
  "${APP_NET_ARGS[@]}" \
  --restart=unless-stopped \
  -e DATABASE_URL="$CONTAINER_DB" \
  -e MT_ENFORCE_ISOLATION=true \
  -e NEXTAUTH_SECRET="$NEXTAUTH_SECRET" \
  -e NEXTAUTH_URL="$URL" \
  -e NEXT_PUBLIC_APP_URL="$URL" \
  -e MARKETING_HOSTS="$MARKETING_HOST" \
  -e SMTP_HOST="${SMTP_HOST:-}" \
  -e SMTP_PORT="${SMTP_PORT:-}" \
  -e SMTP_USER="${SMTP_USER:-}" \
  -e SMTP_PASS="${SMTP_PASS:-}" \
  -e SMTP_FROM="${SMTP_FROM:-}" \
  -e MAIL_RATE_PER_MIN="${MAIL_RATE_PER_MIN:-}" \
  -e MAIL_BURST="${MAIL_BURST:-}" \
  -e MAIL_URGENT_RESERVE="${MAIL_URGENT_RESERVE:-}" \
  -e MAIL_BULK_RATE_PER_MIN="${MAIL_BULK_RATE_PER_MIN:-}" \
  -e MAIL_BULK_BURST="${MAIL_BULK_BURST:-}" \
  -e MAIL_BULK_URGENT_RESERVE="${MAIL_BULK_URGENT_RESERVE:-}" \
  -e MAIL_METER_MODE="${MAIL_METER_MODE:-}" \
  -e MAIL_THROTTLE_LADDER_SEC="${MAIL_THROTTLE_LADDER_SEC:-}" \
  -e MAIL_QUEUE_LANES="${MAIL_QUEUE_LANES:-}" \
  -e MAIL_WORKER_ENABLED="${MAIL_WORKER_ENABLED:-}" \
  -e MAIL_INLINE_TIMEOUT_MS="${MAIL_INLINE_TIMEOUT_MS:-}" \
  -e MAIL_DAILY_CAP="${TOPIC_MAIL_DAILY_CAP:-${MAIL_DAILY_CAP:-}}" \
  -e MAIL_BULK_DAILY_CAP="${MAIL_BULK_DAILY_CAP:-}" \
  -e MAIL_SINK_HOST="$TOPIC_MAIL_SINK_HOST" \
  -e MAIL_SINK_PORT=1025 \
  -e MAIL_RECIPIENT_ALLOWLIST="${TOPIC_MAIL_RECIPIENT_ALLOWLIST:-${MAIL_RECIPIENT_ALLOWLIST:-}}" \
  -e JAAS_APP_ID="${JAAS_APP_ID:-}" \
  -e JAAS_API_KEY_ID="${JAAS_API_KEY_ID:-}" \
  -e JAAS_PRIVATE_KEY="${JAAS_PRIVATE_KEY:-}" \
  -e VAPID_PUBLIC_KEY="${VAPID_PUBLIC_KEY:-}" \
  -e VAPID_PRIVATE_KEY="${VAPID_PRIVATE_KEY:-}" \
  -e VAPID_SUBJECT="${VAPID_SUBJECT:-}" \
  -e EXPO_ACCESS_TOKEN="${EXPO_ACCESS_TOKEN:-}" \
  -e OPERATOR_NAME="${OPERATOR_NAME:-}" \
  -e OPERATOR_ADDRESS="${OPERATOR_ADDRESS:-}" \
  -e OPERATOR_EMAIL="${OPERATOR_EMAIL:-}" \
  -e OPERATOR_PHONE="${OPERATOR_PHONE:-}" \
  -e OPERATOR_RESPONSIBLE="${OPERATOR_RESPONSIBLE:-}" \
  -e OPERATOR_VAT_ID="${OPERATOR_VAT_ID:-}" \
  -e OPERATOR_REGISTER="${OPERATOR_REGISTER:-}" \
  -e OPERATOR_DPO="${OPERATOR_DPO:-}" \
  -e MARKETING_OPERATOR_NAME="${MARKETING_OPERATOR_NAME:-}" \
  -e MARKETING_OPERATOR_ADDRESS="${MARKETING_OPERATOR_ADDRESS:-}" \
  -e MARKETING_OPERATOR_EMAIL="${MARKETING_OPERATOR_EMAIL:-}" \
  -e MARKETING_OPERATOR_PHONE="${MARKETING_OPERATOR_PHONE:-}" \
  -e MARKETING_OPERATOR_RESPONSIBLE="${MARKETING_OPERATOR_RESPONSIBLE:-}" \
  -e MARKETING_OPERATOR_VAT_ID="${MARKETING_OPERATOR_VAT_ID:-}" \
  -e MARKETING_OPERATOR_REGISTER="${MARKETING_OPERATOR_REGISTER:-}" \
  -e MARKETING_OPERATOR_DPO="${MARKETING_OPERATOR_DPO:-}" \
  "$IMAGE"

if [ "$NETWORK" != host ]; then
  docker network connect "$MAIL_SINK_NETWORK" "$CONTAINER" 2>/dev/null \
    || echo "WARN: ${CONTAINER} could not join ${MAIL_SINK_NETWORK} — its mail will wait on its queue"
fi

# ── Container health (local) ─────────────────────────────────────────────────
sleep 3
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || echo "ERR")
echo "==> Container health http://127.0.0.1:${PORT}/api/health -> ${code}"

# ── Routing ──────────────────────────────────────────────────────────────────
SUBLABEL="${ENV_PREFIX}${TOPIC}"              # e.g. pr725
FQDN="$HOST"                                  # e.g. pr725.interncrm.com — one source, see HOST above
MARKETING_SUBLABEL="${ENV_PREFIX}${TOPIC}-m"  # e.g. pr725-m
MARKETING_FQDN="$MARKETING_HOST"

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

write_caddy_site() {
  local fqdn="$1"
  {
    echo "# Managed by infra/server/topic-deploy.sh — topic '${TOPIC}'. Do not edit by hand."
    echo "${fqdn} {"
    if [ -n "$tls_line" ]; then echo "$tls_line"; fi
    echo "    reverse_proxy 127.0.0.1:${PORT}"
    echo "}"
  } | _priv tee "${CADDY_SITES_DIR}/${fqdn}.caddy" >/dev/null
}

route_caddy() {
# This is the whole thing — the ~90 lines the Plesk branch needs for the same job.
_priv mkdir -p "$CADDY_SITES_DIR"

# Prefer the installed wildcard cert. NOT an optimisation: this repo merged its
# last 100 PRs in 9 days and every PR gets its own hostname, while Let's Encrypt
# allows 50 certificates per registered domain per week. Per-hostname issuance
# would exhaust the domain's quota within days and topic environments would then
# fail TLS with nothing in this script looking wrong. The marketing host is the
# same one-label shape (pr<N>-m.<domain>), so it uses this cert too (#2612).
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
write_caddy_site "$FQDN"
write_caddy_site "$MARKETING_FQDN"

# Validate before reloading: Caddy loads one config for the whole box, so a bad
# topic file would take production, preview and every other topic down with it.
if ! eval "$CADDY_RELOAD_CMD"; then
  _priv rm -f "${CADDY_SITES_DIR}/${FQDN}.caddy" "${CADDY_SITES_DIR}/${MARKETING_FQDN}.caddy"
  eval "$CADDY_RELOAD_CMD" || true
  echo "ERROR: caddy rejected the generated site file; removed both topic hosts and reloaded" >&2
  exit 1
fi
echo "==> Caddy route ${FQDN} -> 127.0.0.1:${PORT}"
echo "==> Caddy route ${MARKETING_FQDN} -> 127.0.0.1:${PORT} (MARKETING)"
}

route_plesk_host() {
  local sublabel="$1"
  local fqdn="$2"
  local vhost_dir="/var/www/vhosts/system/${fqdn}/conf"

  if plesk bin subdomain --info "$fqdn" >/dev/null 2>&1; then
    echo "==> Plesk subdomain ${fqdn} already exists"
  else
    echo "==> Creating Plesk subdomain ${fqdn}"
    plesk bin subdomain --create "$sublabel" -domain "$BASE_DOMAIN" -ssl true
  fi

  if [ -n "${WILDCARD_CERT_NAME:-}" ]; then
    echo "==> Assigning '${WILDCARD_CERT_NAME}' to ${fqdn}"
    plesk bin subdomain --update "$sublabel" -domain "$BASE_DOMAIN" -ssl true \
      -certificate-name "$WILDCARD_CERT_NAME" || echo "WARN: cert assignment failed — keeping default cert"
  fi

  mkdir -p "$vhost_dir"
  cat > "${vhost_dir}/vhost_nginx.conf" <<NGINX
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

  echo "==> Reconfiguring Plesk vhost for ${fqdn}"
  plesk sbin httpdmng --reconfigure-domain "$fqdn"
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
# The Plesk box is retired (#2166); this branch remains so a leftover environment
# can still be updated. Both worlds get a subdomain (#2612).

if [ -f "$CONF" ]; then rm -f "$CONF"; fi

command -v plesk >/dev/null || { echo "ERROR: plesk CLI not found on PATH" >&2; exit 1; }

# The wildcard already covers pr<N> and pr<N>-m on BASE_DOMAIN. Import once,
# assign per subdomain. Non-fatal: Cloudflare terminates TLS at the edge anyway.
WILDCARD_CERT_NAME=""
if [ -f "${CERT_DIR}/${BASE_DOMAIN}.cer" ] && [ -f "${CERT_DIR}/${BASE_DOMAIN}.key" ]; then
  WILDCARD_CERT_NAME="wildcard-${BASE_DOMAIN}"
  if ! plesk bin certificate --info "$WILDCARD_CERT_NAME" -domain "$BASE_DOMAIN" >/dev/null 2>&1; then
    echo "==> Importing wildcard cert into Plesk as '${WILDCARD_CERT_NAME}'"
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
else
  echo "==> No wildcard cert files at ${CERT_DIR}/${BASE_DOMAIN}.cer(.key); using subdomain default cert"
fi

route_plesk_host "$SUBLABEL" "$FQDN"
route_plesk_host "$MARKETING_SUBLABEL" "$MARKETING_FQDN"
}

if [ "$ROUTER" = caddy ]; then route_caddy; else route_plesk; fi

# Verify the route resolves to the app locally (Host header hits the new route).
sleep 2
rcode=$(curl -s -k -o /dev/null -w '%{http_code}' -H "Host: ${FQDN}" "https://127.0.0.1/api/health" 2>/dev/null || echo "ERR")
echo "==> Route check (Host: ${FQDN}) -> ${rcode}"
mcode=$(curl -s -k -o /dev/null -w '%{http_code}' -H "Host: ${MARKETING_FQDN}" "https://127.0.0.1/api/health" 2>/dev/null || echo "ERR")
echo "==> Route check (Host: ${MARKETING_FQDN}) -> ${mcode}"

# Marketing host content check (#2579, #2919) — warn only. The same rule as
# infra/deploy-prod.sh and scripts/marketing-content-probe.mjs: the landing's
# <title> must contain the `name` of the host's own /manifest.webmanifest, and
# that name must be neither "Internship CRM" nor the "coreCRM" fallback (the
# brand is missing). The title and the name are never printed: the deploy log is
# as public as the repository. infra/test/marketing-title-check.test.sh keeps
# the three helpers below identical to their deploy-prod.sh twins.
marketing_page_title() {
  tr '\n' ' ' | grep -o '<title[^>]*>[^<]*</title>' | head -n1 \
    | sed -e 's/<[^>]*>//g' -e 's/&lt;/</g; s/&gt;/>/g; s/&quot;/"/g' \
          -e "s/&#x27;/'/g; s/&#39;/'/g" -e 's/&amp;/\&/g' \
    | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//' || true
}
marketing_manifest_name() {
  tr '\n' ' ' | grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 \
    | sed 's/^"name"[[:space:]]*:[[:space:]]*"//; s/"$//' \
    | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//' || true
}
marketing_title_verdict() { # <title> <manifest name>
  local t n
  t="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  n="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"
  if [ -z "$t" ]; then printf '%s\n' 'no <title> in the landing'; return 0; fi
  case "$t" in *'internship crm'*) printf '%s\n' 'it serves the INTERNSHIP landing'; return 0 ;; esac
  if [ -z "$n" ]; then printf '%s\n' 'its /manifest.webmanifest has no name'; return 0; fi
  case "$n" in *'internship crm'*) printf '%s\n' 'its manifest names the INTERNSHIP product'; return 0 ;; esac
  if [ "$n" = 'corecrm' ]; then printf '%s\n' 'its manifest carries the coreCRM fallback name, so its brand is missing'; return 0; fi
  case "$t" in *"$n"*) ;; *) printf '%s\n' 'its <title> does not contain its manifest name' ;; esac
  return 0
}
if [ -z "${MARKETING_HOST:-}" ]; then
  echo "==> Marketing host check skipped — this topic has no marketing host"
else
  page="$(curl -sS --max-time 15 -H "Host: ${MARKETING_HOST}" "http://127.0.0.1:${PORT}/" 2>/dev/null || true)"
  manifest="$(curl -sS --max-time 15 -H "Host: ${MARKETING_HOST}" "http://127.0.0.1:${PORT}/manifest.webmanifest" 2>/dev/null || true)"
  title="$(printf '%s' "$page" | marketing_page_title)"
  mname="$(printf '%s' "$manifest" | marketing_manifest_name)"
  verdict="$(marketing_title_verdict "$title" "$mname")"
  if [ -n "$verdict" ]; then
    echo "==> WARN: marketing host ${MARKETING_HOST} on :${PORT}: ${verdict}"
  else
    echo "==> Marketing host ${MARKETING_HOST} OK"
  fi
fi

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

echo "==> Topic '${TOPIC}' is live at ${URL} and ${MARKETING_URL}"
